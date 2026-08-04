import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  IncompleteSameOwnerCleanupError,
} from "@drawbackengine/chess-evaluator";
import {
  schema9EngineSchedule,
  SCHEMA9_GENERATOR_CONFIG,
  SCHEMA9_GENERATOR_COMPLETION_FORMAT,
  SCHEMA9_GENERATOR_LAUNCH_FORMAT,
  SCHEMA9_GENERATOR_RECEIPT_VERSION,
  SCHEMA9_LEDGER_SPLITS,
  SCHEMA9_SCHEDULE_AUTHORITY_ID,
  SCHEMA9_SCHEDULE_PROFILE,
  type Schema9LedgerSplit,
  type Schema9ProducerRuntimeIdentity,
} from "@drawbackengine/simulation-arena";
import {
  runPlayerPrivateBatch,
  type PlayerPrivateBatchOptions,
  type PlayerPrivateBatchResult,
} from "./player-private-batch.js";
import {
  assertSameSchema9ProducerRuntimeIdentity,
  assertSchema9ProducerRuntimeIdentity,
  computeSchema9ProducerRuntimeIdentity,
  runSchema9AuthenticatedGit,
  schema9RuntimeDescriptor,
} from "./schema9-runtime-identity.js";

const FULL_GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SCHEDULE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const WINDOWS_RESERVED =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const PRIVATE_TOKEN = /(?:password|passwd|secret|credential|api[-_.]?key|token)/iu;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const VERSIONED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/v[0-9]+$/u;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const WINDOWS_UNC = /^(?:\\\\|\/\/)[^/\\]/u;
const USER_DIRECTORY =
  /(?:^|[/\\])(?:Users|home)[/\\][^/\\]+(?:[/\\]|$)/iu;
const IDENTITY_EMBEDDED_BEFORE = /[\p{L}\p{N}]$/u;
const IDENTITY_EMBEDDED_AFTER = /^[\p{L}\p{N}]/u;
const TEMPORARY_BUNDLE_PREFIX = ".drawback-schema9-bundle-";
const MAX_SCHEMA9_WORKERS = 256;
const BUNDLE_FILES = Object.freeze({
  trace: "trace.ndjson",
  launchReceipt: "launch.json",
  completionReceipt: "completion.json",
} as const);

export interface Schema9PlayerPrivateBundleOptions {
  readonly ledgerSplit: Schema9LedgerSplit;
  readonly games: number;
  readonly workers: number;
  readonly scheduleId: string;
  readonly bundlePath: string;
  readonly producerEngineCommit: string;
  readonly producerRuntimeIdentity: Schema9ProducerRuntimeIdentity;
  readonly signal?: AbortSignal;
  readonly onProgress?: NonNullable<PlayerPrivateBatchOptions["onProgress"]>;
}

export interface Schema9PlayerPrivateBundleResult {
  readonly ledgerSplit: Schema9LedgerSplit;
  readonly scheduleId: string;
  readonly producerEngineCommit: string;
  readonly producerRuntimeIdentity: Schema9ProducerRuntimeIdentity;
  readonly output: Readonly<{
    sha256: string;
    bytes: number;
    games: number;
    firstGameIndex: number;
    lastGameIndex: number;
  }>;
  readonly files: typeof BUNDLE_FILES;
}

export interface Schema9PlayerPrivateCliOptions
  extends Omit<
    Schema9PlayerPrivateBundleOptions,
    | "producerEngineCommit"
    | "producerRuntimeIdentity"
    | "signal"
    | "onProgress"
  > {
  readonly engineRepository: string;
}

export interface Schema9PlayerPrivateBundleDependencies {
  readonly runBatch?: (
    options: PlayerPrivateBatchOptions,
  ) => Promise<PlayerPrivateBatchResult>;
  readonly verifyProducerCommit?: () => Promise<string>;
  readonly verifyProducerRuntimeIdentity?: (
  ) => Promise<Schema9ProducerRuntimeIdentity>;
  readonly beforeFinalBundleAuthentication?: (
    temporaryPath: string,
  ) => Promise<void>;
}

export interface OwnedDirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

export function parseSchema9PlayerPrivateCliArguments(
  arguments_: readonly string[],
  invocationDirectory = process.cwd(),
): Schema9PlayerPrivateCliOptions {
  const required = Object.freeze([
    "--ledger-split",
    "--games",
    "--workers",
    "--schedule-id",
    "--bundle",
    "--engine-repository",
  ] as const);
  if (arguments_.length !== required.length * 2) {
    throw new TypeError("Schema-9 generation requires every declared flag once.");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined
      || !required.includes(flag as (typeof required)[number])
      || value === undefined
      || value.startsWith("--")
    ) {
      throw new TypeError(`Unsupported schema-9 generation flag: ${flag ?? ""}.`);
    }
    if (values.has(flag)) {
      throw new TypeError(`${flag} may appear only once.`);
    }
    values.set(flag, value);
  }
  const valueAfter = (flag: (typeof required)[number]): string => {
    const value = values.get(flag);
    if (value === undefined) {
      throw new TypeError(`${flag} is required.`);
    }
    return value;
  };
  const rawSplit = valueAfter("--ledger-split");
  if (!SCHEMA9_LEDGER_SPLITS.includes(rawSplit as Schema9LedgerSplit)) {
    throw new RangeError("Schema-9 ledger split is invalid.");
  }
  const ledgerSplit = rawSplit as Schema9LedgerSplit;
  const games = canonicalPositiveInteger(valueAfter("--games"), "games");
  schema9EngineSchedule(ledgerSplit, games);
  const workers = checkedWorkers(canonicalPositiveInteger(
    valueAfter("--workers"),
    "workers",
  ));
  const scheduleId = checkedScheduleId(valueAfter("--schedule-id"));
  return Object.freeze({
    ledgerSplit,
    games,
    workers,
    scheduleId,
    bundlePath: resolve(invocationDirectory, valueAfter("--bundle")),
    engineRepository: resolve(
      invocationDirectory,
      valueAfter("--engine-repository"),
    ),
  });
}

export async function verifiedCleanEngineCommit(
  suppliedRepository: string,
  executingRepository = executingEngineRepository(),
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const supplied = await realpath(suppliedRepository);
  const executing = await realpath(executingRepository);
  throwIfAborted(signal);
  if (relative(executing, supplied) !== "") {
    throw new TypeError(
      "Supplied Engine repository is not the executing source checkout.",
    );
  }
  const head = (await git(supplied, ["rev-parse", "HEAD"], signal)).trim();
  if (!FULL_GIT_COMMIT.test(head)) {
    throw new TypeError("Executing Engine commit is invalid.");
  }
  const status = await git(supplied, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ], signal);
  if (status.length !== 0) {
    throw new TypeError("Executing Engine repository is not clean.");
  }
  const replacements = await git(supplied, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace",
  ], signal);
  if (replacements.trim().length !== 0) {
    throw new TypeError("Executing Engine repository contains replace refs.");
  }
  const tagged = await git(supplied, ["ls-files", "-v", "-z"], signal);
  for (const entry of tagged.split("\0")) {
    const tag = entry[0];
    if (tag === "S" || (tag !== undefined && /^[a-z]$/u.test(tag))) {
      throw new TypeError(
        "Executing Engine repository contains hidden index flags.",
      );
    }
  }
  return head;
}

export async function createSchema9PlayerPrivateBundle(
  options: Schema9PlayerPrivateBundleOptions,
  dependencies: Schema9PlayerPrivateBundleDependencies = {},
): Promise<Schema9PlayerPrivateBundleResult> {
  const schedule = schema9EngineSchedule(options.ledgerSplit, options.games);
  const scheduleId = checkedScheduleId(options.scheduleId);
  if (!FULL_GIT_COMMIT.test(options.producerEngineCommit)) {
    throw new TypeError("Producer Engine commit must be a full Git commit.");
  }
  assertSchema9ProducerRuntimeIdentity(options.producerRuntimeIdentity);
  checkedWorkers(options.workers);
  throwIfAborted(options.signal);
  const finalPath = resolve(options.bundlePath);
  const repository = await realpath(executingEngineRepository());
  if (isWithin(repository, finalPath)) {
    throw new TypeError("Private schema-9 bundles must be outside the repository.");
  }
  await requireAbsent(finalPath);
  const parent = await realpath(dirname(finalPath));
  if (isWithin(repository, parent)) {
    throw new TypeError("Private schema-9 bundles must be outside the repository.");
  }
  const publishedPath = join(parent, basename(finalPath));
  await requireAbsent(publishedPath);
  const temporaryPath = await mkdtemp(join(parent, TEMPORARY_BUNDLE_PREFIX));
  const ownerIdentity = await ownedSchema9DirectoryIdentity(temporaryPath);
  try {
    await assertSameProducerCommit(
      options.producerEngineCommit,
      dependencies.verifyProducerCommit,
      options.signal,
    );
    await assertSameProducerRuntimeIdentity(
      options.producerRuntimeIdentity,
      dependencies.verifyProducerRuntimeIdentity,
      options.signal,
    );
    const launch = Object.freeze({
      format: SCHEMA9_GENERATOR_LAUNCH_FORMAT,
      version: SCHEMA9_GENERATOR_RECEIPT_VERSION,
      scheduleAuthorityId: SCHEMA9_SCHEDULE_AUTHORITY_ID,
      scheduleId,
      ledgerSplit: schedule.ledgerSplit,
      engineSplit: schedule.engineSplit,
      splitCounts: schedule.splitCounts,
      seedRoots: schedule.seedRoots,
      scheduleProfile: schedule.scheduleProfile,
      generationConfig: SCHEMA9_GENERATOR_CONFIG,
      producerEngineCommit: options.producerEngineCommit,
      producerRuntimeIdentity: options.producerRuntimeIdentity,
    });
    assertPathFreeSchema9Receipt(launch, "Schema-9 launch receipt");
    const launchBytes = canonicalJsonRecord(launch);
    await writeFile(
      join(temporaryPath, BUNDLE_FILES.launchReceipt),
      launchBytes,
      { flag: "wx", mode: 0o600 },
    );
    const runBatch = dependencies.runBatch ?? runPlayerPrivateBatch;
    const written = await runBatch({
      split: "train",
      splitCounts: schedule.splitCounts,
      workers: options.workers,
      labelSeed: schedule.seedRoots[0],
      gameplaySeed: schedule.seedRoots[1],
      parameterSeed: schedule.seedRoots[2],
      outputPath: join(temporaryPath, BUNDLE_FILES.trace),
      maxPlies: SCHEMA9_GENERATOR_CONFIG.maxPlies,
      windowSize: options.workers * 4,
      maxDepth: SCHEMA9_GENERATOR_CONFIG.maxDepth,
      maxNodes: SCHEMA9_GENERATOR_CONFIG.maxNodes,
      temperatureCp: SCHEMA9_GENERATOR_CONFIG.temperatureCp,
      profileId: SCHEMA9_SCHEDULE_PROFILE.id,
      evaluator: Object.freeze({
        kind: SCHEMA9_GENERATOR_CONFIG.evaluator.kind,
        version: SCHEMA9_GENERATOR_CONFIG.evaluator.version,
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined
        ? {}
        : { onProgress: options.onProgress }),
    });
    if (
      written.games !== schedule.games
      || written.firstGameIndex !== 0
      || written.lastGameIndex !== schedule.games - 1
      || written.profile.id !== SCHEMA9_SCHEDULE_PROFILE.id
      || written.profile.policyId !== SCHEMA9_SCHEDULE_PROFILE.policyId
      || written.evaluatorId !== "drawback-material/v1"
      || !matchesSchema9GenerationConfig(written.generationConfig)
    ) {
      throw new Error("Schema-9 batch result does not match its fixed profile.");
    }
    const authenticatedTrace = await authenticateSchema9TraceFile(
      join(temporaryPath, BUNDLE_FILES.trace),
      options.signal,
    );
    if (
      authenticatedTrace.bytes !== written.bytes
      || authenticatedTrace.sha256 !== written.sha256
    ) {
      throw new Error(
        "Schema-9 trace bytes do not match the batch result authentication.",
      );
    }
    await assertSameProducerCommit(
      options.producerEngineCommit,
      dependencies.verifyProducerCommit,
      options.signal,
    );
    await assertSameProducerRuntimeIdentity(
      options.producerRuntimeIdentity,
      dependencies.verifyProducerRuntimeIdentity,
      options.signal,
    );
    const output = Object.freeze({
      sha256: authenticatedTrace.sha256,
      bytes: authenticatedTrace.bytes,
      games: written.games,
      firstGameIndex: written.firstGameIndex,
      lastGameIndex: written.lastGameIndex,
    });
    const completion = Object.freeze({
      format: SCHEMA9_GENERATOR_COMPLETION_FORMAT,
      version: SCHEMA9_GENERATOR_RECEIPT_VERSION,
      scheduleId,
      ledgerSplit: schedule.ledgerSplit,
      state: "completed" as const,
      producerEngineCommit: options.producerEngineCommit,
      producerRuntimeIdentity: options.producerRuntimeIdentity,
      launchReceiptSha256: createHash("sha256")
        .update(launchBytes)
        .digest("hex"),
      output,
    });
    assertPathFreeSchema9Receipt(completion, "Schema-9 completion receipt");
    const completionBytes = canonicalJsonRecord(completion);
    await writeFile(
      join(temporaryPath, BUNDLE_FILES.completionReceipt),
      completionBytes,
      { flag: "wx", mode: 0o600 },
    );
    await dependencies.beforeFinalBundleAuthentication?.(temporaryPath);
    await assertSameProducerCommit(
      options.producerEngineCommit,
      dependencies.verifyProducerCommit,
      options.signal,
    );
    await assertSameProducerRuntimeIdentity(
      options.producerRuntimeIdentity,
      dependencies.verifyProducerRuntimeIdentity,
      options.signal,
    );
    await assertExactFinalBundle(
      temporaryPath,
      ownerIdentity,
      launchBytes,
      completionBytes,
      output,
      options.signal,
    );
    throwIfAborted(options.signal);
    await requireAbsent(publishedPath);
    const result = Object.freeze({
      ledgerSplit: schedule.ledgerSplit,
      scheduleId,
      producerEngineCommit: options.producerEngineCommit,
      producerRuntimeIdentity: options.producerRuntimeIdentity,
      output,
      files: BUNDLE_FILES,
    });
    await rename(temporaryPath, publishedPath);
    return result;
  } catch (error: unknown) {
    return cleanupBundleOrThrow(
      error,
      temporaryPath,
      ownerIdentity,
    );
  }
}

async function assertExactFinalBundle(
  temporaryPath: string,
  ownerIdentity: OwnedDirectoryIdentity,
  launchBytes: Buffer,
  completionBytes: Buffer,
  output: Readonly<{ sha256: string; bytes: number }>,
  signal: AbortSignal | undefined,
): Promise<void> {
  await assertOwnedSchema9Directory(temporaryPath, ownerIdentity);
  const files = (await readdir(temporaryPath)).sort();
  const expectedFiles = Object.values(BUNDLE_FILES).sort();
  if (
    files.length !== expectedFiles.length
    || files.some((file, index) => file !== expectedFiles[index])
  ) {
    throw new Error("Schema-9 bundle changed before publication.");
  }
  const trace = await authenticateSchema9TraceFile(
    join(temporaryPath, BUNDLE_FILES.trace),
    signal,
  );
  const launch = await authenticateSchema9TraceFile(
    join(temporaryPath, BUNDLE_FILES.launchReceipt),
    signal,
  );
  const completion = await authenticateSchema9TraceFile(
    join(temporaryPath, BUNDLE_FILES.completionReceipt),
    signal,
  );
  if (
    trace.sha256 !== output.sha256
    || trace.bytes !== output.bytes
    || launch.sha256 !== sha256Buffer(launchBytes)
    || launch.bytes !== launchBytes.length
    || completion.sha256 !== sha256Buffer(completionBytes)
    || completion.bytes !== completionBytes.length
  ) {
    throw new Error("Schema-9 bundle bytes changed before publication.");
  }
  await assertOwnedSchema9Directory(temporaryPath, ownerIdentity);
}

async function assertOwnedSchema9Directory(
  path: string,
  expected: OwnedDirectoryIdentity,
): Promise<void> {
  const actual = await ownedSchema9DirectoryIdentity(path);
  if (
    actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.birthtimeNs !== expected.birthtimeNs
  ) {
    throw new Error("Schema-9 bundle owner changed before publication.");
  }
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function matchesSchema9GenerationConfig(
  value: unknown,
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const evaluator = value["evaluator"];
  const hypotheses = value["opponentHypotheses"];
  return hasExactKeys(value, [
    "maxPlies",
    "maxDepth",
    "maxNodes",
    "temperatureCp",
    "topK",
    "leafCacheEntries",
    "leafCacheHistoryMode",
    "opponentAggregation",
    "evaluator",
    "opponentHypotheses",
  ])
    && isRecord(evaluator)
    && hasExactKeys(evaluator, ["kind", "version", "evaluatorId"])
    && isRecord(hypotheses)
    && hasExactKeys(hypotheses, ["kind", "version"])
    && value["maxPlies"] === SCHEMA9_GENERATOR_CONFIG.maxPlies
    && value["maxDepth"] === SCHEMA9_GENERATOR_CONFIG.maxDepth
    && value["maxNodes"] === SCHEMA9_GENERATOR_CONFIG.maxNodes
    && value["temperatureCp"] === SCHEMA9_GENERATOR_CONFIG.temperatureCp
    && value["topK"] === SCHEMA9_GENERATOR_CONFIG.topK
    && value["leafCacheEntries"]
      === SCHEMA9_GENERATOR_CONFIG.leafCacheEntries
    && value["leafCacheHistoryMode"]
      === SCHEMA9_GENERATOR_CONFIG.leafCacheHistoryMode
    && value["opponentAggregation"]
      === SCHEMA9_GENERATOR_CONFIG.opponentAggregation
    && evaluator["kind"] === SCHEMA9_GENERATOR_CONFIG.evaluator.kind
    && evaluator["version"] === SCHEMA9_GENERATOR_CONFIG.evaluator.version
    && evaluator["evaluatorId"]
      === SCHEMA9_GENERATOR_CONFIG.evaluator.evaluatorId
    && hypotheses["kind"]
      === SCHEMA9_GENERATOR_CONFIG.opponentHypotheses.kind
    && hypotheses["version"]
      === SCHEMA9_GENERATOR_CONFIG.opponentHypotheses.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function canonicalPositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`Schema-9 ${label} must be a canonical positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`Schema-9 ${label} exceeds the safe integer range.`);
  }
  return parsed;
}

function checkedScheduleId(value: string): string {
  const lowered = value.toLocaleLowerCase("en-US");
  if (
    !SCHEDULE_ID.test(value)
    || value.includes("..")
    || value.includes("\\")
    || WINDOWS_RESERVED.test(value)
    || PRIVATE_TOKEN.test(value)
    || environmentUserTokens().some((token) =>
      containsDelimitedPrivateToken(lowered, token)
    )
  ) {
    throw new TypeError(
      "Schema-9 schedule ID must be a canonical path-free identifier.",
    );
  }
  return value;
}

function checkedWorkers(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_SCHEMA9_WORKERS
  ) {
    throw new RangeError(
      `Schema-9 workers must be between 1 and ${String(MAX_SCHEMA9_WORKERS)}.`,
    );
  }
  return value;
}

function executingEngineRepository(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`)
      && !isAbsolute(child));
}

export async function authenticateSchema9TraceFile(
  path: string,
  signal: AbortSignal | undefined,
): Promise<Readonly<{ sha256: string; bytes: number }>> {
  throwIfAborted(signal);
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    throw new TypeError("Schema-9 trace output is not a regular file.");
  }
  const digest = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(path, {
    flags: "r",
    ...(signal === undefined ? {} : { signal }),
  });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    throwIfAborted(signal);
    bytes += chunk.length;
    digest.update(chunk);
  }
  throwIfAborted(signal);
  const after = await lstat(path);
  if (
    !after.isFile()
    || after.dev !== metadata.dev
    || after.ino !== metadata.ino
    || after.size !== metadata.size
    || after.mtimeMs !== metadata.mtimeMs
    || bytes !== metadata.size
  ) {
    throw new Error("Schema-9 trace changed while it was authenticated.");
  }
  return Object.freeze({ sha256: digest.digest("hex"), bytes });
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new Error("Schema-9 bundle output already exists.");
}

function canonicalJsonRecord(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

async function cleanupBundleOrThrow(
  originalFailure: unknown,
  target: string,
  ownerIdentity: OwnedDirectoryIdentity,
): Promise<never> {
  const cleanupOwnerIdentity = Object.freeze({});
  const cleanup = () => removeOwnedSchema9Directory(target, ownerIdentity);
  try {
    await cleanup();
  } catch (cleanupFailure: unknown) {
    throw new IncompleteSameOwnerCleanupError(
      [originalFailure, cleanupFailure],
      "Private schema-9 bundle cleanup remains incomplete.",
      cleanup,
      () => false,
      cleanupOwnerIdentity,
    );
  }
  throw originalFailure;
}

export async function ownedSchema9DirectoryIdentity(
  path: string,
): Promise<OwnedDirectoryIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory()) {
    throw new TypeError("Schema-9 temporary owner is not a directory.");
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeNs: metadata.birthtimeNs,
  });
}

export async function removeOwnedSchema9Directory(
  target: string,
  expected: OwnedDirectoryIdentity,
): Promise<void> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(target, { bigint: true });
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
      "Schema-9 cleanup target is no longer the owned directory.",
    );
  }
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}

async function assertSameProducerCommit(
  expected: string,
  suppliedVerifier: (() => Promise<string>) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const verify = suppliedVerifier ?? (() => {
    const repository = executingEngineRepository();
    return verifiedCleanEngineCommit(repository, repository, signal);
  });
  throwIfAborted(signal);
  const actual = await verify();
  throwIfAborted(signal);
  if (actual !== expected) {
    throw new Error("Executing Engine commit changed during generation.");
  }
}

async function assertSameProducerRuntimeIdentity(
  expected: Schema9ProducerRuntimeIdentity,
  suppliedVerifier:
    | (() => Promise<Schema9ProducerRuntimeIdentity>)
    | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const verify = suppliedVerifier ?? (() =>
    computeSchema9ProducerRuntimeIdentity(
      executingEngineRepository(),
      schema9RuntimeDescriptor(),
      signal,
    ));
  const actual = await verify();
  assertSameSchema9ProducerRuntimeIdentity(actual, expected);
}

function environmentUserTokens(): readonly string[] {
  const tokens = new Set<string>();
  for (const value of [
    process.env["USERNAME"],
    process.env["USER"],
    process.env["LOGNAME"],
  ]) {
    const canonical = value?.trim().toLocaleLowerCase("en-US");
    if (canonical !== undefined && canonical.length >= 3) {
      tokens.add(canonical);
    }
  }
  return [...tokens];
}

export function assertPathFreeSchema9Receipt(
  value: unknown,
  label: string,
  privateTokens: readonly string[] = environmentUserTokens(),
): void {
  const seen = new Set<object>();
  const visit = (current: unknown, path: string, depth: number): void => {
    if (depth > 128) {
      throw new TypeError(`${label} exceeds the supported JSON depth.`);
    }
    if (typeof current === "string") {
      const lowered = current.toLocaleLowerCase("en-US");
      if (
        current.length > 4096
        || looksLikePath(current)
        || privateTokens.some((token) =>
          containsDelimitedPrivateToken(lowered, token)
        )
        || PRIVATE_TOKEN.test(current)
      ) {
        throw new TypeError(`${path} contains private path or user data.`);
      }
      return;
    }
    if (current === null || typeof current === "boolean") {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new TypeError(`${path} contains a non-canonical JSON number.`);
      }
      return;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        throw new TypeError(`${label} contains a JSON cycle.`);
      }
      seen.add(current);
      current.forEach((item, index) => {
        visit(item, `${path}[${String(index)}]`, depth + 1);
      });
      seen.delete(current);
      return;
    }
    if (typeof current === "object") {
      if (seen.has(current)) {
        throw new TypeError(`${label} contains a JSON cycle.`);
      }
      seen.add(current);
      for (const [key, item] of Object.entries(current)) {
        visit(key, `${path} key`, depth + 1);
        visit(item, `${path}.${key}`, depth + 1);
      }
      seen.delete(current);
      return;
    }
    throw new TypeError(`${label} contains a non-JSON value.`);
  };
  visit(value, label, 0);
}

function looksLikePath(value: string): boolean {
  if (
    value.startsWith("/")
    || value.startsWith("~/")
    || value.startsWith("./")
    || value.startsWith("../")
    || WINDOWS_ABSOLUTE.test(value)
    || WINDOWS_UNC.test(value)
    || USER_DIRECTORY.test(value)
    || value.toLocaleLowerCase("en-US").startsWith("file:")
    || URL_SCHEME.test(value)
    || value.includes("\\")
    || /(?:^|\/)\.\.?($|\/)/u.test(value)
  ) {
    return true;
  }
  return value.includes("/") && !VERSIONED_ID.test(value);
}

function containsDelimitedPrivateToken(
  value: string,
  rawToken: string,
): boolean {
  const token = rawToken.trim().toLocaleLowerCase("en-US");
  if (token.length === 0) {
    return false;
  }
  let offset = 0;
  while (offset <= value.length - token.length) {
    const index = value.indexOf(token, offset);
    if (index < 0) {
      return false;
    }
    if (
      !IDENTITY_EMBEDDED_BEFORE.test(value.slice(0, index))
      && !IDENTITY_EMBEDDED_AFTER.test(value.slice(index + token.length))
    ) {
      return true;
    }
    offset = index + 1;
  }
  return false;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Schema-9 generation was interrupted.");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

function git(
  repository: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return runSchema9AuthenticatedGit(
    ["--no-replace-objects", "-C", repository, ...arguments_],
    repository,
    signal,
  );
}
