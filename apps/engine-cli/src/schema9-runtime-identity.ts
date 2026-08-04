import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  IncompleteSameOwnerCleanupError,
} from "@drawbackengine/chess-evaluator";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  sep,
} from "node:path";
import {
  SCHEMA9_COORDINATOR_COMPONENT_ID,
  SCHEMA9_PARALLEL_WORKER_COMPONENT_ID,
  SCHEMA9_PRODUCER_RUNTIME_ALGORITHM,
  SCHEMA9_PRODUCER_RUNTIME_FORMAT,
  SCHEMA9_PRODUCER_RUNTIME_VERSION,
  type Schema9ProducerRuntimeIdentity,
  type Schema9RuntimeComponentIdentity,
  type Schema9RuntimeDescriptor,
} from "@drawbackengine/simulation-arena";

const SHA256 = /^[0-9a-f]{64}$/u;
const NODE_VERSION = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const RUNTIME_STRING = /^[0-9A-Za-z._-]+$/u;
const RUNTIME_FILE_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".node", ".wasm"]);
const WORKSPACE_RUNTIME_PACKAGES = Object.freeze([
  "packages/shared",
  "packages/probe-search",
  "packages/drawback-engine",
  "packages/chess-core",
  "packages/drawback-search",
  "packages/chess-evaluator",
  "packages/simulation-trace",
  "packages/simulation-arena",
] as const);
const EXTERNAL_RUNTIME_BINDINGS = Object.freeze([
  Object.freeze({ consumer: "packages/chess-core", packageName: "chess.js" }),
  Object.freeze({ consumer: "packages/chess-core", packageName: "chessops" }),
  Object.freeze({ consumer: "packages/chess-evaluator", packageName: "chess.js" }),
  Object.freeze({ consumer: "packages/drawback-engine", packageName: "chess.js" }),
  Object.freeze({ consumer: "packages/drawback-search", packageName: "chessops" }),
] as const);
const ROOT_RUNTIME_INPUTS = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
] as const);
const OPTIONAL_ROOT_RUNTIME_INPUTS = Object.freeze([
  ".npmrc",
  ".pnpmfile.cjs",
  "pnpmfile.cjs",
] as const);
const BLOCKED_NODE_ENVIRONMENT = Object.freeze([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_PRESERVE_SYMLINKS_MAIN",
] as const);
const ATTESTATION_TEMPORARY_PREFIX = "drawback-schema9-runtime-";
const COMPONENT_MANIFEST_FORMAT =
  "drawbackengine-schema9-runtime-component/v1";
const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const TERMINATION_SETTLEMENT_GRACE_MS = 250;
const MAX_EXTERNAL_DEPENDENCY_DEPTH = 64;
const EXTERNAL_DEPENDENCY_CYCLE_FORMAT =
  "drawbackengine-schema9-external-dependency-cycle/v1";
const EXTERNAL_OPTIONAL_DEPENDENCY_FORMAT =
  "drawbackengine-schema9-optional-dependency/v1";

interface AuthenticatedPnpmEntrypoint {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly version: string;
}

interface AuthenticatedGitExecutable {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly environment: NodeJS.ProcessEnv;
}

interface RuntimeFileIdentity {
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface Schema9RuntimeAttestationDependencies {
  readonly prepareSnapshot?: (
    sourceRepository: string,
    producerEngineCommit: string,
    snapshotDirectory: string,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
  readonly temporaryParent?: string;
  readonly runtime?: Schema9RuntimeDescriptor;
  readonly removeOwnedDirectory?: typeof removeOwnedRuntimeDirectory;
}

export interface OwnedRuntimeDirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

export function schema9RuntimeDescriptor(
  input: Readonly<{
    nodeVersion?: string;
    platform?: string;
    architecture?: string;
    execArgv?: readonly string[];
    environment?: NodeJS.ProcessEnv;
  }> = {},
): Schema9RuntimeDescriptor {
  const execArgv = input.execArgv ?? process.execArgv;
  const environment = input.environment ?? process.env;
  if (execArgv.length !== 0) {
    throw new TypeError(
      "Schema-9 generation rejects Node execution arguments.",
    );
  }
  for (const name of BLOCKED_NODE_ENVIRONMENT) {
    if ((environment[name] ?? "").trim().length !== 0) {
      throw new TypeError(
        `Schema-9 generation rejects the ${name} environment setting.`,
      );
    }
  }
  const descriptor = Object.freeze({
    nodeVersion: input.nodeVersion ?? process.version,
    platform: input.platform ?? process.platform,
    architecture: input.architecture ?? process.arch,
    execArgv: Object.freeze([] as const),
  });
  assertRuntimeDescriptor(descriptor);
  return descriptor;
}

export async function computeSchema9ProducerRuntimeIdentity(
  repository: string,
  runtime: Schema9RuntimeDescriptor = schema9RuntimeDescriptor(),
  signal?: AbortSignal,
): Promise<Schema9ProducerRuntimeIdentity> {
  assertRuntimeDescriptor(runtime);
  throwIfAborted(signal);
  const canonicalRepository = await realpath(repository);
  const sharedEntries = await collectSharedRuntimeEntries(
    canonicalRepository,
    signal,
  );
  const coordinatorEntries = [
    ...sharedEntries,
    ...await collectWorkspacePackageEntries(
      canonicalRepository,
      "apps/engine-cli",
      signal,
    ),
    ...await collectWorkspaceDependencyBindingEntries(
      canonicalRepository,
      "apps/engine-cli",
      signal,
    ),
  ].sort(compareRuntimeEntries);
  const workerEntries = [...sharedEntries].sort(compareRuntimeEntries);
  requireLogicalEntry(
    coordinatorEntries,
    "repo:apps/engine-cli/dist/schema9-player-private-cli.js",
  );
  requireLogicalEntry(
    workerEntries,
    "repo:packages/simulation-arena/dist/player-private-parallel-worker.js",
  );
  const coordinator = componentIdentity(
    SCHEMA9_COORDINATOR_COMPONENT_ID,
    coordinatorEntries,
  );
  const parallelWorker = componentIdentity(
    SCHEMA9_PARALLEL_WORKER_COMPONENT_ID,
    workerEntries,
  );
  const aggregateRecord = Object.freeze({
    format: SCHEMA9_PRODUCER_RUNTIME_FORMAT,
    version: SCHEMA9_PRODUCER_RUNTIME_VERSION,
    algorithm: SCHEMA9_PRODUCER_RUNTIME_ALGORITHM,
    runtime,
    coordinator,
    parallelWorker,
  });
  const identity = Object.freeze({
    format: SCHEMA9_PRODUCER_RUNTIME_FORMAT,
    version: SCHEMA9_PRODUCER_RUNTIME_VERSION,
    algorithm: SCHEMA9_PRODUCER_RUNTIME_ALGORITHM,
    runtime,
    coordinator,
    parallelWorker,
    aggregateSha256: sha256(canonicalJson(aggregateRecord)),
  });
  assertSchema9ProducerRuntimeIdentity(identity);
  return identity;
}

export async function attestSchema9ProducerRuntime(
  repository: string,
  producerEngineCommit: string,
  signal?: AbortSignal,
  dependencies: Schema9RuntimeAttestationDependencies = {},
): Promise<Schema9ProducerRuntimeIdentity> {
  const runtime = dependencies.runtime ?? schema9RuntimeDescriptor();
  assertRuntimeDescriptor(runtime);
  throwIfAborted(signal);
  const canonicalRepository = await realpath(repository);
  const actual = await computeSchema9ProducerRuntimeIdentity(
    canonicalRepository,
    runtime,
    signal,
  );
  const temporaryParent = await realpath(
    dependencies.temporaryParent ?? tmpdir(),
  );
  const temporaryRoot = await mkdtemp(join(
    temporaryParent,
    ATTESTATION_TEMPORARY_PREFIX,
  ));
  const ownerIdentity = await ownedRuntimeDirectoryIdentity(temporaryRoot);
  const cleanupOwnerIdentity = Object.freeze({});
  const cleanup = () => (
    dependencies.removeOwnedDirectory ?? removeOwnedRuntimeDirectory
  )(temporaryRoot, ownerIdentity);
  const snapshot = join(temporaryRoot, "snapshot");
  let failure: unknown;
  let rebuilt: Schema9ProducerRuntimeIdentity | undefined;
  try {
    const prepare = dependencies.prepareSnapshot ?? prepareFreshSnapshot;
    await prepare(
      canonicalRepository,
      producerEngineCommit,
      snapshot,
      signal,
    );
    throwIfAborted(signal);
    rebuilt = await computeSchema9ProducerRuntimeIdentity(
      snapshot,
      runtime,
      signal,
    );
    assertSameSchema9ProducerRuntimeIdentity(actual, rebuilt);
  } catch (error: unknown) {
    failure = error;
  }
  let cleanupFailure: unknown;
  try {
    await cleanup();
  } catch (error: unknown) {
    cleanupFailure = error;
  }
  if (cleanupFailure !== undefined) {
    throw new IncompleteSameOwnerCleanupError(
      [
        ...(failure === undefined ? [] : [failure]),
        cleanupFailure,
      ],
      failure === undefined
        ? "Schema-9 runtime attestation cleanup remains incomplete."
        : "Schema-9 runtime attestation failed and cleanup remains incomplete.",
      cleanup,
      () => false,
      cleanupOwnerIdentity,
    );
  }
  if (failure !== undefined) {
    throw asError(failure);
  }
  if (rebuilt === undefined) {
    throw new Error("Schema-9 runtime attestation lost its rebuilt identity.");
  }
  return rebuilt;
}

export function assertSameSchema9ProducerRuntimeIdentity(
  actual: Schema9ProducerRuntimeIdentity,
  expected: Schema9ProducerRuntimeIdentity,
): void {
  assertSchema9ProducerRuntimeIdentity(actual);
  assertSchema9ProducerRuntimeIdentity(expected);
  if (canonicalJson(actual).compare(canonicalJson(expected)) !== 0) {
    throw new Error(
      "Executing Schema-9 runtime does not match the isolated clean rebuild.",
    );
  }
}

export function assertSchema9ProducerRuntimeIdentity(
  value: unknown,
): asserts value is Schema9ProducerRuntimeIdentity {
  if (!isRecord(value) || !hasExactKeys(value, [
    "format",
    "version",
    "algorithm",
    "runtime",
    "coordinator",
    "parallelWorker",
    "aggregateSha256",
  ])) {
    throw new TypeError("Schema-9 producer runtime identity is malformed.");
  }
  if (
    value["format"] !== SCHEMA9_PRODUCER_RUNTIME_FORMAT
    || value["version"] !== SCHEMA9_PRODUCER_RUNTIME_VERSION
    || value["algorithm"] !== SCHEMA9_PRODUCER_RUNTIME_ALGORITHM
    || !SHA256.test(stringValue(value["aggregateSha256"]))
  ) {
    throw new TypeError("Schema-9 producer runtime identity is unsupported.");
  }
  assertRuntimeDescriptor(value["runtime"]);
  assertComponentIdentity(
    value["coordinator"],
    SCHEMA9_COORDINATOR_COMPONENT_ID,
  );
  assertComponentIdentity(
    value["parallelWorker"],
    SCHEMA9_PARALLEL_WORKER_COMPONENT_ID,
  );
  const aggregate = Object.freeze({
    format: value["format"],
    version: value["version"],
    algorithm: value["algorithm"],
    runtime: value["runtime"],
    coordinator: value["coordinator"],
    parallelWorker: value["parallelWorker"],
  });
  if (sha256(canonicalJson(aggregate)) !== value["aggregateSha256"]) {
    throw new TypeError(
      "Schema-9 producer runtime aggregate digest is invalid.",
    );
  }
}

export async function ownedRuntimeDirectoryIdentity(
  path: string,
): Promise<OwnedRuntimeDirectoryIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory()) {
    throw new TypeError("Schema-9 runtime owner is not a directory.");
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeNs: metadata.birthtimeNs,
  });
}

export async function removeOwnedRuntimeDirectory(
  path: string,
  expected: OwnedRuntimeDirectoryIdentity,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (
    !metadata.isDirectory()
    || metadata.dev !== expected.dev
    || metadata.ino !== expected.ino
    || metadata.birthtimeNs !== expected.birthtimeNs
  ) {
    throw new Error(
      "Schema-9 runtime cleanup target is no longer the owned directory.",
    );
  }
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

async function collectSharedRuntimeEntries(
  repository: string,
  signal: AbortSignal | undefined,
): Promise<RuntimeFileIdentity[]> {
  const entries: RuntimeFileIdentity[] = [];
  for (const path of ROOT_RUNTIME_INPUTS) {
    entries.push(await trackedTextFileIdentity(
      join(repository, ...path.split("/")),
      `repo:${path}`,
      signal,
    ));
  }
  for (const path of OPTIONAL_ROOT_RUNTIME_INPUTS) {
    const absolutePath = join(repository, path);
    if (await regularFileExists(absolutePath)) {
      entries.push(path.endsWith(".cjs")
        ? await fileIdentity(absolutePath, `repo:${path}`, signal)
        : await trackedTextFileIdentity(
          absolutePath,
          `repo:${path}`,
          signal,
        ));
    }
  }
  for (const packagePath of WORKSPACE_RUNTIME_PACKAGES) {
    entries.push(...await collectWorkspacePackageEntries(
      repository,
      packagePath,
      signal,
    ));
    entries.push(...await collectWorkspaceDependencyBindingEntries(
      repository,
      packagePath,
      signal,
    ));
  }
  for (const binding of EXTERNAL_RUNTIME_BINDINGS) {
    entries.push(...await collectExternalPackageEntries(
      repository,
      binding.consumer,
      binding.packageName,
      signal,
    ));
  }
  assertUniqueLogicalIds(entries);
  return entries;
}

async function collectWorkspacePackageEntries(
  repository: string,
  packagePath: string,
  signal: AbortSignal | undefined,
): Promise<RuntimeFileIdentity[]> {
  const packageRoot = join(repository, ...packagePath.split("/"));
  const entries = [await trackedTextFileIdentity(
    join(packageRoot, "package.json"),
    `repo:${packagePath}/package.json`,
    signal,
  )];
  entries.push(...await collectRuntimeFiles(
    join(packageRoot, "dist"),
    (relativePath) => `repo:${packagePath}/dist/${relativePath}`,
    signal,
  ));
  return entries;
}

async function collectExternalPackageEntries(
  repository: string,
  consumer: string,
  expectedName: string,
  signal: AbortSignal | undefined,
): Promise<RuntimeFileIdentity[]> {
  const installed = join(
    repository,
    ...consumer.split("/"),
    "node_modules",
    ...expectedName.split("/"),
  );
  const packageRoot = await realpath(installed);
  return collectExternalPackageClosure(
    packageRoot,
    expectedName,
    `npm-binding:${consumer}`,
    signal,
    0,
    new Set(),
  );
}

async function collectExternalPackageClosure(
  packageRoot: string,
  expectedName: string,
  chainPrefix: string,
  signal: AbortSignal | undefined,
  depth: number,
  ancestorRoots: ReadonlySet<string>,
): Promise<RuntimeFileIdentity[]> {
  if (depth > MAX_EXTERNAL_DEPENDENCY_DEPTH) {
    throw new Error("Schema-9 external dependency graph is too deep.");
  }
  throwIfAborted(signal);
  const canonicalRoot = await realpath(packageRoot);
  const manifestBytes = await readAuthenticatedFile(
    join(canonicalRoot, "package.json"),
    signal,
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  if (
    !isRecord(manifest)
    || manifest["name"] !== expectedName
    || typeof manifest["version"] !== "string"
    || !RUNTIME_STRING.test(manifest["version"])
  ) {
    throw new TypeError(
      `Schema-9 runtime package ${expectedName} has invalid identity.`,
    );
  }
  const prefix = `${chainPrefix}:${expectedName}@${manifest["version"]}`;
  if (ancestorRoots.has(canonicalRoot)) {
    return [identityFromBytes(
      `${prefix}:dependency-cycle.json`,
      canonicalJson(Object.freeze({
        format: EXTERNAL_DEPENDENCY_CYCLE_FORMAT,
        packageName: expectedName,
        version: manifest["version"],
      })),
    )];
  }
  const entries = [identityFromBytes(
    `${prefix}:package.json`,
    manifestBytes,
  )];
  entries.push(...await collectRuntimeFiles(
    canonicalRoot,
    (relativePath) => `${prefix}:${relativePath}`,
    signal,
    new Set(["node_modules"]),
    new Set(["package.json"]),
  ));
  const nextAncestors = new Set(ancestorRoots);
  nextAncestors.add(canonicalRoot);
  for (const dependency of externalDependencySpecifications(manifest)) {
    throwIfAborted(signal);
    let dependencyRoot: string;
    try {
      dependencyRoot = await resolveExternalDependencyRoot(
        canonicalRoot,
        dependency.name,
        signal,
      );
    } catch (error: unknown) {
      if (dependency.optional && isNodeError(error, "MODULE_NOT_FOUND")) {
        entries.push(identityFromBytes(
          `${prefix}:optional:${dependency.name}:absent.json`,
          canonicalJson(Object.freeze({
            format: EXTERNAL_OPTIONAL_DEPENDENCY_FORMAT,
            packageName: dependency.name,
            requested: dependency.requested,
            state: "absent",
          })),
        ));
        continue;
      }
      throw new Error(
        `Schema-9 runtime dependency ${dependency.name} could not be resolved.`,
        { cause: error },
      );
    }
    entries.push(...await collectExternalPackageClosure(
      dependencyRoot,
      dependency.name,
      `${prefix}:dependency`,
      signal,
      depth + 1,
      nextAncestors,
    ));
  }
  return entries;
}

interface ExternalDependencySpecification {
  readonly name: string;
  readonly requested: string;
  readonly optional: boolean;
}

function externalDependencySpecifications(
  manifest: Readonly<Record<string, unknown>>,
): readonly ExternalDependencySpecification[] {
  const dependencies = dependencyMap(manifest["dependencies"], false);
  const optionalDependencies = dependencyMap(
    manifest["optionalDependencies"],
    true,
  );
  const merged = new Map<string, ExternalDependencySpecification>();
  for (const dependency of [...dependencies, ...optionalDependencies]) {
    merged.set(dependency.name, dependency);
  }
  return [...merged.values()].sort((left, right) => (
    compareStrings(left.name, right.name)
  ));
}

function dependencyMap(
  value: unknown,
  optional: boolean,
): readonly ExternalDependencySpecification[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw new TypeError("Schema-9 external dependency map is malformed.");
  }
  return Object.keys(value).sort().map((name) => {
    const requested = value[name];
    if (typeof requested !== "string" || requested.length === 0) {
      throw new TypeError(
        "Schema-9 external dependency version is malformed.",
      );
    }
    return Object.freeze({ name, requested, optional });
  });
}

async function resolveExternalDependencyRoot(
  packageRoot: string,
  dependencyName: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  const requireFromPackage = createRequire(join(packageRoot, "package.json"));
  const resolvedEntry = requireFromPackage.resolve(dependencyName);
  let candidate = dirname(await realpath(resolvedEntry));
  for (;;) {
    throwIfAborted(signal);
    const manifestPath = join(candidate, "package.json");
    if (await regularFileExists(manifestPath)) {
      const manifestBytes = await readAuthenticatedFile(
        manifestPath,
        signal,
      );
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
      if (isRecord(manifest) && manifest["name"] === dependencyName) {
        return realpath(candidate);
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(
        `Schema-9 resolved dependency ${dependencyName} has no package root.`,
      );
    }
    candidate = parent;
  }
}

async function collectWorkspaceDependencyBindingEntries(
  repository: string,
  consumer: string,
  signal: AbortSignal | undefined,
): Promise<RuntimeFileIdentity[]> {
  const consumerRoot = join(repository, ...consumer.split("/"));
  const manifestBytes = await readAuthenticatedFile(
    join(consumerRoot, "package.json"),
    signal,
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  if (!isRecord(manifest)) {
    throw new TypeError("Schema-9 workspace package manifest is malformed.");
  }
  const dependencies = manifest["dependencies"];
  if (dependencies === undefined) {
    return [];
  }
  if (!isRecord(dependencies)) {
    throw new TypeError("Schema-9 workspace dependencies are malformed.");
  }
  const entries: RuntimeFileIdentity[] = [];
  for (const dependencyName of Object.keys(dependencies).sort()) {
    const version = dependencies[dependencyName];
    if (typeof version !== "string" || !version.startsWith("workspace:")) {
      continue;
    }
    const installed = join(
      consumerRoot,
      "node_modules",
      ...dependencyName.split("/"),
    );
    const packageRoot = await realpath(installed);
    const dependencyManifestBytes = await readAuthenticatedFile(
      join(packageRoot, "package.json"),
      signal,
    );
    const dependencyManifest = JSON.parse(
      dependencyManifestBytes.toString("utf8"),
    ) as unknown;
    if (
      !isRecord(dependencyManifest)
      || dependencyManifest["name"] !== dependencyName
    ) {
      throw new TypeError(
        "Schema-9 workspace dependency binding has the wrong package identity.",
      );
    }
    const prefix = `workspace-binding:${consumer}:${dependencyName}`;
    entries.push(await trackedTextFileIdentity(
      join(packageRoot, "package.json"),
      `${prefix}:package.json`,
      signal,
    ));
    entries.push(...await collectRuntimeFiles(
      join(packageRoot, "dist"),
      (relativePath) => `${prefix}:dist/${relativePath}`,
      signal,
    ));
  }
  return entries;
}

async function collectRuntimeFiles(
  root: string,
  logicalId: (relativePath: string) => string,
  signal: AbortSignal | undefined,
  excludedDirectories: ReadonlySet<string> = new Set(),
  excludedFiles: ReadonlySet<string> = new Set(),
): Promise<RuntimeFileIdentity[]> {
  throwIfAborted(signal);
  const entries: RuntimeFileIdentity[] = [];
  const visit = async (directory: string): Promise<void> => {
    throwIfAborted(signal);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareStrings(left.name, right.name));
    for (const child of children) {
      throwIfAborted(signal);
      const path = join(directory, child.name);
      if (child.isSymbolicLink()) {
        throw new TypeError("Schema-9 runtime trees may not contain symlinks.");
      }
      if (child.isDirectory()) {
        if (!excludedDirectories.has(child.name)) {
          await visit(path);
        }
        continue;
      }
      if (!child.isFile()) {
        throw new TypeError(
          "Schema-9 runtime trees contain an unsupported file type.",
        );
      }
      const relativePath = portableRelative(root, path);
      if (
        excludedFiles.has(relativePath)
        || !RUNTIME_FILE_EXTENSIONS.has(extname(child.name).toLowerCase())
      ) {
        continue;
      }
      entries.push(await fileIdentity(path, logicalId(relativePath), signal));
    }
  };
  await visit(root);
  if (entries.length === 0) {
    throw new Error("Schema-9 runtime component contains no executable files.");
  }
  return entries;
}

async function fileIdentity(
  path: string,
  id: string,
  signal: AbortSignal | undefined,
): Promise<RuntimeFileIdentity> {
  return identityFromBytes(id, await readAuthenticatedFile(path, signal));
}

async function trackedTextFileIdentity(
  path: string,
  id: string,
  signal: AbortSignal | undefined,
): Promise<RuntimeFileIdentity> {
  const raw = await readAuthenticatedFile(path, signal);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error: unknown) {
    throw new TypeError(
      "Schema-9 tracked runtime metadata must be valid UTF-8.",
      { cause: error },
    );
  }
  const withoutCrLf = decoded.replace(/\r\n/gu, "\n");
  if (withoutCrLf.includes("\r")) {
    throw new TypeError(
      "Schema-9 tracked runtime metadata contains a lone carriage return.",
    );
  }
  return identityFromBytes(id, Buffer.from(withoutCrLf, "utf8"));
}

async function readAuthenticatedFile(
  path: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  throwIfAborted(signal);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile()) {
    throw new TypeError("Schema-9 runtime input is not a regular file.");
  }
  const bytes = await readFile(
    path,
    signal === undefined ? undefined : { signal },
  );
  throwIfAborted(signal);
  const after = await lstat(path, { bigint: true });
  if (
    !after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs
    || BigInt(bytes.length) !== before.size
  ) {
    throw new Error("Schema-9 runtime input changed while it was hashed.");
  }
  return bytes;
}

function identityFromBytes(id: string, bytes: Buffer): RuntimeFileIdentity {
  if (id.length === 0 || id.includes("\\") || /(?:^|:)\.\.?\//u.test(id)) {
    throw new TypeError("Schema-9 runtime logical file ID is invalid.");
  }
  return Object.freeze({
    id,
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
}

function componentIdentity<
  ComponentId extends
    | typeof SCHEMA9_COORDINATOR_COMPONENT_ID
    | typeof SCHEMA9_PARALLEL_WORKER_COMPONENT_ID,
>(
  componentId: ComponentId,
  entries: readonly RuntimeFileIdentity[],
): Schema9RuntimeComponentIdentity & Readonly<{ componentId: ComponentId }> {
  if (entries.length === 0) {
    throw new Error("Schema-9 runtime component is empty.");
  }
  const manifest = Object.freeze({
    format: COMPONENT_MANIFEST_FORMAT,
    componentId,
    entries,
  });
  return Object.freeze({
    componentId,
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    sha256: sha256(canonicalJson(manifest)),
  });
}

async function prepareFreshSnapshot(
  sourceRepository: string,
  producerEngineCommit: string,
  snapshotDirectory: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const pnpm = await authenticatedPnpmEntrypoint(sourceRepository, signal);
  const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
  await runSchema9AuthenticatedGit(
    [
      "--no-replace-objects",
      "-c",
      "core.autocrlf=false",
      "-c",
      `core.hooksPath=${hooksPath}`,
      "clone",
      "--no-local",
      "--no-hardlinks",
      "--no-checkout",
      "--quiet",
      sourceRepository,
      snapshotDirectory,
    ],
    dirname(snapshotDirectory),
    signal,
  );
  await runSchema9AuthenticatedGit(
    [
      "--no-replace-objects",
      "-c",
      `core.hooksPath=${hooksPath}`,
      "-C",
      snapshotDirectory,
      "checkout",
      "--detach",
      "--force",
      "--quiet",
      producerEngineCommit,
    ],
    dirname(snapshotDirectory),
    signal,
  );
  const head = (await runSchema9AuthenticatedGit(
    ["--no-replace-objects", "-C", snapshotDirectory, "rev-parse", "HEAD"],
    dirname(snapshotDirectory),
    signal,
  )).trim();
  if (head !== producerEngineCommit) {
    throw new Error("Isolated Schema-9 rebuild checked out the wrong commit.");
  }
  const buildEnvironment = sanitizedChildEnvironment();
  buildEnvironment["CI"] = "1";
  await runCommand(
    process.execPath,
    [
      pnpm.path,
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    snapshotDirectory,
    buildEnvironment,
    signal,
  );
  await runCommand(
    process.execPath,
    [
      pnpm.path,
      "--config.ignore-scripts=true",
      "-r",
      "--if-present",
      "run",
      "build",
    ],
    snapshotDirectory,
    buildEnvironment,
    signal,
  );
  await assertPnpmEntrypointUnchanged(pnpm, signal);
  const status = await runSchema9AuthenticatedGit(
    [
      "--no-replace-objects",
      "-C",
      snapshotDirectory,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    dirname(snapshotDirectory),
    signal,
  );
  if (status.length !== 0) {
    throw new Error("Isolated Schema-9 rebuild modified tracked source.");
  }
}

/** Runs Git from a fixed system location and proves it did not change in use. */
export async function runSchema9AuthenticatedGit(
  arguments_: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const executable = await authenticatedGitExecutable(signal);
  try {
    return await runCommand(
      executable.path,
      arguments_,
      cwd,
      executable.environment,
      signal,
    );
  } finally {
    await assertAuthenticatedGitUnchanged(executable);
  }
}

async function authenticatedGitExecutable(
  signal: AbortSignal | undefined,
): Promise<AuthenticatedGitExecutable> {
  throwIfAborted(signal);
  let candidate: string;
  let systemRoot: string | undefined;
  if (process.platform === "win32") {
    const configuredSystemRoot = process.env["SystemRoot"]?.trim();
    if (configuredSystemRoot === undefined || !isAbsolute(configuredSystemRoot)) {
      throw new TypeError(
        "Schema-9 Git authentication requires an absolute SystemRoot.",
      );
    }
    systemRoot = await realpath(configuredSystemRoot);
    const programFiles = await realpath(join(parse(systemRoot).root, "Program Files"));
    candidate = await realpath(join(programFiles, "Git", "cmd", "git.exe"));
    const child = relative(programFiles, candidate);
    if (
      child === ""
      || child === ".."
      || child.startsWith(`..${sep}`)
      || isAbsolute(child)
    ) {
      throw new TypeError("Schema-9 Git escaped the fixed Program Files root.");
    }
  } else {
    const candidates = new Set<string>();
    for (const path of ["/usr/bin/git", "/bin/git"] as const) {
      try {
        const resolved = await realpath(path);
        const metadata = await lstat(resolved);
        if (metadata.isFile()) {
          candidates.add(resolved);
        }
      } catch (error: unknown) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      }
    }
    if (candidates.size !== 1) {
      throw new TypeError("Schema-9 requires one fixed system Git executable.");
    }
    candidate = [...candidates][0] as string;
  }
  throwIfAborted(signal);
  const metadata = await lstat(candidate, { bigint: true });
  if (!metadata.isFile()) {
    throw new TypeError("Schema-9 system Git is not a regular file.");
  }
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const canonicalName = name.toUpperCase();
      return canonicalName === "TEMP" || canonicalName === "TMP";
    }),
  );
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  environment["PATH"] = process.platform === "win32"
    ? [dirname(candidate), join(systemRoot as string, "System32"), systemRoot as string]
      .join(";")
    : "/usr/bin:/bin";
  if (process.platform === "win32") {
    environment["SystemRoot"] = systemRoot;
    environment["WINDIR"] = systemRoot;
    environment["ComSpec"] = join(systemRoot as string, "System32", "cmd.exe");
    environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
  }
  environment["GIT_ATTR_NOSYSTEM"] = "1";
  environment["GIT_CONFIG_COUNT"] = "0";
  environment["GIT_CONFIG_GLOBAL"] = nullDevice;
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_OPTIONAL_LOCKS"] = "0";
  environment["GIT_PAGER"] = "cat";
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["LC_ALL"] = "C";
  return Object.freeze({
    path: candidate,
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    environment,
  });
}

async function assertAuthenticatedGitUnchanged(
  expected: AuthenticatedGitExecutable,
): Promise<void> {
  const actual = await lstat(expected.path, { bigint: true });
  if (
    !actual.isFile()
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.size !== expected.size
    || actual.mtimeNs !== expected.mtimeNs
    || actual.ctimeNs !== expected.ctimeNs
  ) {
    throw new Error("Authenticated Schema-9 system Git changed during use.");
  }
}

async function authenticatedPnpmEntrypoint(
  repository: string,
  signal: AbortSignal | undefined,
): Promise<AuthenticatedPnpmEntrypoint> {
  const configured = process.env["npm_execpath"]?.trim();
  if (configured === undefined || !isAbsolute(configured)) {
    throw new TypeError(
      "Schema-9 generation requires an absolute npm_execpath for pnpm.",
    );
  }
  const path = await realpath(configured);
  const bytes = await readAuthenticatedFile(path, signal);
  const manifestBytes = await readAuthenticatedFile(
    join(repository, "package.json"),
    signal,
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  if (!isRecord(manifest) || typeof manifest["packageManager"] !== "string") {
    throw new TypeError("Engine packageManager identity is missing.");
  }
  const match = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(
    manifest["packageManager"],
  );
  if (match?.[1] === undefined) {
    throw new TypeError("Engine packageManager must pin an exact pnpm version.");
  }
  const version = (await runCommand(
    process.execPath,
    [path, "--version"],
    repository,
    sanitizedChildEnvironment(),
    signal,
  )).trim();
  if (version !== match[1]) {
    throw new Error("Executing pnpm does not match the repository pin.");
  }
  return Object.freeze({
    path,
    sha256: sha256(bytes),
    bytes: bytes.length,
    version,
  });
}

async function assertPnpmEntrypointUnchanged(
  expected: AuthenticatedPnpmEntrypoint,
  signal: AbortSignal | undefined,
): Promise<void> {
  const bytes = await readAuthenticatedFile(expected.path, signal);
  if (
    bytes.length !== expected.bytes
    || sha256(bytes) !== expected.sha256
  ) {
    throw new Error("Executing pnpm changed during the isolated rebuild.");
  }
}

function runCommand(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  timeoutMilliseconds = COMMAND_TIMEOUT_MS,
  terminateTree: (child: ChildProcess) => Promise<void> = terminateProcessTree,
  killDirectChild: (child: ChildProcess) => boolean = (child) => (
    child.kill("SIGKILL")
  ),
): Promise<string> {
  throwIfAborted(signal);
  return new Promise((accept, reject) => {
    let timedOut = false;
    let outputExceeded = false;
    let launchFailure: Error | undefined;
    let termination: Promise<void> | undefined;
    let forcedSettlement: NodeJS.Timeout | undefined;
    let settlementStarted = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(
      executable,
      [...arguments_],
      {
        cwd,
        env: environment,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const scheduleForcedSettlement = (): void => {
      forcedSettlement ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        beginSettlement(null, null);
      }, TERMINATION_SETTLEMENT_GRACE_MS);
    };
    const terminate = (): void => {
      termination ??= terminateTree(child).catch((error: unknown) => {
        killDirectChild(child);
        throw asError(error);
      });
      // Observe cleanup rejection immediately while retaining it for settle().
      void termination.then(
        scheduleForcedSettlement,
        scheduleForcedSettlement,
      );
    };
    const abort = (): void => {
      terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMilliseconds);
    const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const decoded = chunk.toString("utf8");
      if (target === "stdout") {
        stdout += decoded;
      } else {
        stderr += decoded;
      }
      if (
        Buffer.byteLength(stdout) + Buffer.byteLength(stderr)
          > 16 * 1024 * 1024
      ) {
        outputExceeded = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      capture("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture("stderr", chunk);
    });
    child.once("error", (error) => {
      launchFailure = error;
    });
    const settle = async (
      code: number | null,
      exitSignal: NodeJS.Signals | null,
    ): Promise<void> => {
      clearTimeout(timeout);
      if (forcedSettlement !== undefined) {
        clearTimeout(forcedSettlement);
      }
      signal?.removeEventListener("abort", abort);
      let terminationFailure: unknown;
      try {
        await termination;
      } catch (error: unknown) {
        terminationFailure = error;
      }
      if (signal?.aborted === true) {
        const interruption = signal.reason instanceof Error
          ? signal.reason
          : new Error("Schema-9 runtime command was interrupted.");
        reject(terminationFailure === undefined
          ? interruption
          : new AggregateError(
            [interruption, terminationFailure],
            "Schema-9 runtime command interruption cleanup failed.",
          ));
        return;
      }
      if (timedOut) {
        const timeoutFailure = new Error(
          "Schema-9 runtime command exceeded its time limit.",
        );
        reject(terminationFailure === undefined
          ? timeoutFailure
          : new AggregateError(
            [timeoutFailure, terminationFailure],
            "Schema-9 runtime command timed out and tree cleanup failed.",
          ));
        return;
      }
      if (terminationFailure !== undefined) {
        reject(asError(terminationFailure));
        return;
      }
      if (outputExceeded) {
        reject(new Error("Schema-9 runtime command produced excessive output."));
        return;
      }
      if (launchFailure !== undefined || code !== 0 || exitSignal !== null) {
        reject(new Error(
          `Schema-9 runtime command failed: ${basename(executable)}.`,
          {
            cause: launchFailure ?? new Error(
              stderr.trim().length === 0
                ? `exit=${String(code)} signal=${String(exitSignal)}`
                : stderr.trim(),
            ),
          },
        ));
        return;
      }
      accept(stdout);
    };
    const beginSettlement = (
      code: number | null,
      exitSignal: NodeJS.Signals | null,
    ): void => {
      if (settlementStarted) {
        return;
      }
      settlementStarted = true;
      void settle(code, exitSignal).catch((error: unknown) => {
        reject(asError(error));
      });
    };
    child.once("close", (code, exitSignal) => {
      beginSettlement(code, exitSignal);
    });
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("Schema-9 runtime child process has no authenticated PID.");
  }
  if (process.platform === "win32") {
    const taskkill = await authenticatedWindowsTaskkill();
    await new Promise<void>((accept, reject) => {
      execFile(
        taskkill.path,
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 10_000 },
        (error) => {
          void assertAuthenticatedSystemToolUnchanged(taskkill)
            .then(() => {
              if (error !== null) {
                reject(new Error(
                  "Windows could not prove Schema-9 runtime process-tree cleanup.",
                  { cause: error },
                ));
                return;
              }
              accept();
            })
            .catch((authenticationFailure: unknown) => {
              reject(asError(authenticationFailure));
            });
        },
      );
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error: unknown) {
    if (!isNodeError(error, "ESRCH")) {
      throw error;
    }
  }
}

interface AuthenticatedSystemTool {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

async function authenticatedWindowsTaskkill(): Promise<AuthenticatedSystemTool> {
  const systemRoot = process.env["SystemRoot"]?.trim();
  if (systemRoot === undefined || !isAbsolute(systemRoot)) {
    throw new TypeError(
      "Windows Schema-9 cleanup requires an absolute SystemRoot.",
    );
  }
  const canonicalRoot = await realpath(systemRoot);
  const path = await realpath(join(canonicalRoot, "System32", "taskkill.exe"));
  const child = relative(canonicalRoot, path);
  if (
    child === ""
    || child === ".."
    || child.startsWith(`..${sep}`)
    || isAbsolute(child)
  ) {
    throw new TypeError("Windows taskkill escaped the authenticated system root.");
  }
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile()) {
    throw new TypeError("Windows taskkill is not a regular system file.");
  }
  return Object.freeze({
    path,
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
  });
}

async function assertAuthenticatedSystemToolUnchanged(
  expected: AuthenticatedSystemTool,
): Promise<void> {
  const actual = await lstat(expected.path, { bigint: true });
  if (
    !actual.isFile()
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.size !== expected.size
    || actual.mtimeNs !== expected.mtimeNs
  ) {
    throw new Error("Authenticated Windows cleanup tool changed during use.");
  }
}

export function runSchema9RuntimeCommandForTesting(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMilliseconds: number,
  environmentSource: NodeJS.ProcessEnv = process.env,
  terminateForTesting?: () => Promise<void>,
  killDirectChildForTesting?: () => boolean,
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError("Schema-9 runtime command timeout must be positive.");
  }
  return runCommand(
    executable,
    arguments_,
    cwd,
    sanitizedChildEnvironment(environmentSource),
    signal,
    timeoutMilliseconds,
    terminateForTesting === undefined
      ? terminateProcessTree
      : () => terminateForTesting(),
    killDirectChildForTesting === undefined
      ? (child) => child.kill("SIGKILL")
      : () => killDirectChildForTesting(),
  );
}

function sanitizedChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const excluded = new Set([
    ...BLOCKED_NODE_ENVIRONMENT,
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
    "GIT_EXEC_PATH",
    "GIT_NAMESPACE",
    "GIT_REPLACE_REF_BASE",
    "GIT_TEMPLATE_DIR",
  ]);
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(source).filter(([name]) => {
      const lowered = name.toLowerCase();
      const upper = name.toUpperCase();
      return !excluded.has(upper)
      && !upper.startsWith("GIT_CONFIG_KEY_")
      && !upper.startsWith("GIT_CONFIG_VALUE_")
      && !lowered.startsWith("npm_config_")
      && !lowered.startsWith("pnpm_config_")
      && !lowered.startsWith("pnpm_");
    }),
  );
  const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_CONFIG_GLOBAL"] = nullConfig;
  environment["NPM_CONFIG_USERCONFIG"] = nullConfig;
  environment["NPM_CONFIG_GLOBALCONFIG"] = nullConfig;
  environment["NPM_CONFIG_OFFLINE"] = "true";
  environment["NPM_CONFIG_FROZEN_LOCKFILE"] = "true";
  environment["NPM_CONFIG_IGNORE_SCRIPTS"] = "true";
  environment["PNPM_CONFIG_USERCONFIG"] = nullConfig;
  environment["PNPM_CONFIG_GLOBALCONFIG"] = nullConfig;
  environment["PNPM_CONFIG_OFFLINE"] = "true";
  environment["PNPM_CONFIG_FROZEN_LOCKFILE"] = "true";
  environment["PNPM_CONFIG_IGNORE_SCRIPTS"] = "true";
  environment["npm_config_userconfig"] = nullConfig;
  environment["npm_config_globalconfig"] = nullConfig;
  environment["npm_config_offline"] = "true";
  environment["npm_config_frozen_lockfile"] = "true";
  environment["npm_config_ignore_scripts"] = "true";
  environment["pnpm_config_userconfig"] = nullConfig;
  environment["pnpm_config_globalconfig"] = nullConfig;
  environment["pnpm_config_offline"] = "true";
  environment["pnpm_config_frozen_lockfile"] = "true";
  environment["pnpm_config_ignore_scripts"] = "true";
  return environment;
}

export function schema9SanitizedChildEnvironmentForTesting(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return sanitizedChildEnvironment(source);
}

function assertRuntimeDescriptor(
  value: unknown,
): asserts value is Schema9RuntimeDescriptor {
  if (!isRecord(value) || !hasExactKeys(value, [
    "nodeVersion",
    "platform",
    "architecture",
    "execArgv",
  ])) {
    throw new TypeError("Schema-9 runtime descriptor is malformed.");
  }
  if (
    !NODE_VERSION.test(stringValue(value["nodeVersion"]))
    || !RUNTIME_STRING.test(stringValue(value["platform"]))
    || !RUNTIME_STRING.test(stringValue(value["architecture"]))
    || !Array.isArray(value["execArgv"])
    || value["execArgv"].length !== 0
  ) {
    throw new TypeError("Schema-9 runtime descriptor is unsupported.");
  }
}

function assertComponentIdentity(
  value: unknown,
  componentId: string,
): void {
  if (!isRecord(value) || !hasExactKeys(value, [
    "componentId",
    "files",
    "bytes",
    "sha256",
  ])) {
    throw new TypeError("Schema-9 runtime component identity is malformed.");
  }
  if (
    value["componentId"] !== componentId
    || !isPositiveSafeInteger(value["files"])
    || !isPositiveSafeInteger(value["bytes"])
    || !SHA256.test(stringValue(value["sha256"]))
  ) {
    throw new TypeError("Schema-9 runtime component identity is invalid.");
  }
}

function requireLogicalEntry(
  entries: readonly RuntimeFileIdentity[],
  id: string,
): void {
  if (!entries.some((entry) => entry.id === id)) {
    throw new Error(`Schema-9 runtime is missing required module ${id}.`);
  }
}

function assertUniqueLogicalIds(entries: readonly RuntimeFileIdentity[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error("Schema-9 runtime contains duplicate logical file IDs.");
    }
    ids.add(entry.id);
  }
}

function compareRuntimeEntries(
  left: RuntimeFileIdentity,
  right: RuntimeFileIdentity,
): number {
  return compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path);
  if (
    value.length === 0
    || value === ".."
    || value.startsWith(`..${sep}`)
  ) {
    throw new TypeError("Schema-9 runtime file escaped its component root.");
  }
  return value.split(sep).join("/");
}

export function canonicalSchema9RuntimeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalJsonValue(value))}\n`, "utf8");
}

function canonicalJson(value: unknown): Buffer {
  return canonicalSchema9RuntimeJson(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalJsonValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  throw new TypeError("Schema-9 runtime identity contains a non-JSON value.");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Schema-9 runtime attestation was interrupted.");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new TypeError(
        "Optional Schema-9 runtime input is not a regular file.",
      );
    }
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("Unknown Schema-9 runtime failure.", { cause: value });
}
