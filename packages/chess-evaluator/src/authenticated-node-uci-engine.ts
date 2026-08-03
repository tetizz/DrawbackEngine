import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UciClient } from "./client.js";
import type { ConstraintEngineFingerprint } from "./constraint-cache.js";
import {
  NodeProcessUciTransport,
  type NodeProcessTransportOptions,
} from "./node-process-transport.js";
import type {
  UciClientOptions,
  UciEngineIdentity,
  UciOptionSetting,
} from "./types.js";
import { errorProvesUciProcessTerminated } from "./types.js";

export interface SerializableUciEngineIdentity {
  /** Exact value expected from the engine's `id name` response. */
  readonly uciName: string;
  /** Stable engine family used in public provenance. */
  readonly engine: string;
  /** Caller-pinned engine build/version used in public provenance. */
  readonly version: string;
}

export interface AuthenticatedNodeUciEngineConfig {
  readonly process: NodeProcessTransportOptions & {
    /** Expected SHA-256 of the executable file bytes, verified before spawn. */
    readonly executableSha256: string;
    /**
     * Caller-pinned digest of the canonical runtime manifest, including
     * semantic arguments and any cwd-resolved evaluation assets.
     */
    readonly runtimeContextSha256: string;
  };
  readonly client?: UciClientOptions;
  readonly engineIdentity: SerializableUciEngineIdentity;
  /**
   * Canonical caller-owned digest of every evaluation-affecting UCI setting.
   * This value is never inferred from the executable.
   */
  readonly optionsDigest: string;
  /**
   * Optional caller-pinned digest of the exact, ordered `option ...` lines
   * advertised during UCI initialization.
   */
  readonly advertisedOptionsSha256?: string;
}

export interface AuthenticatedNodeUciEngine {
  readonly client: UciClient;
  readonly identity: AuthenticatedUciEngineIdentity;
  readonly fingerprint: ConstraintEngineFingerprint;
  readonly executableSha256: string;
  readonly publicFingerprint: string;
  close(): Promise<void>;
}

export interface AuthenticatedUciEngineIdentity
  extends Omit<UciEngineIdentity, "name"> {
  readonly name: string;
}

interface ValidatedAuthenticatedNodeUciEngineConfig {
  readonly process: NodeProcessTransportOptions;
  readonly executableSha256: string;
  readonly runtimeContextSha256: string;
  readonly client: UciClientOptions;
  readonly engineIdentity: SerializableUciEngineIdentity;
  readonly optionsDigest: string;
  readonly advertisedOptionsSha256?: string;
}

export class UciExecutableIntegrityError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UciExecutableIntegrityError";
  }
}

export class AuthenticatedNodeUciEngineError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthenticatedNodeUciEngineError";
  }
}

export class AuthenticatedNodeUciEngineCloseError extends Error {
  public constructor(
    message: string,
    public readonly privateExecutableRemoved: boolean,
    public readonly processTerminated: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthenticatedNodeUciEngineCloseError";
  }
}

export class IncompleteSameOwnerCleanupError extends AggregateError {
  public readonly cleanupComplete = false;
  readonly #closeSameOwner: () => Promise<void>;
  readonly #cleanupProvesComplete: (error: unknown) => boolean;
  readonly #cleanupFailureMessage: string;
  readonly #failures: readonly unknown[];
  readonly #cleanupOwnerIdentity: object;
  #activeRetry: Promise<void> | undefined;

  public constructor(
    failures: readonly unknown[],
    cleanupFailureMessage: string,
    closeSameOwner: () => Promise<void>,
    cleanupProvesComplete: (error: unknown) => boolean =
      authenticatedCleanupProvesComplete,
    cleanupOwnerIdentity: object = Object.freeze({}),
  ) {
    super([...failures], cleanupFailureMessage);
    this.name = "IncompleteSameOwnerCleanupError";
    this.#failures = [...failures];
    this.#cleanupFailureMessage = cleanupFailureMessage;
    this.#closeSameOwner = closeSameOwner;
    this.#cleanupProvesComplete = cleanupProvesComplete;
    this.#cleanupOwnerIdentity = cleanupOwnerIdentity;
  }

  public cleanupOwnerIdentity(): object {
    return this.#cleanupOwnerIdentity;
  }

  /** Retries cleanup through the retained owner; it never creates a process. */
  public retryCleanup(): Promise<void> {
    if (this.#activeRetry !== undefined) {
      return this.#activeRetry;
    }
    const attempt = this.#retryCleanupOnce();
    this.#activeRetry = attempt;
    void attempt.then(
      () => {
        if (this.#activeRetry === attempt) {
          this.#activeRetry = undefined;
        }
      },
      () => {
        if (this.#activeRetry === attempt) {
          this.#activeRetry = undefined;
        }
      },
    );
    return attempt;
  }

  async #retryCleanupOnce(): Promise<void> {
    try {
      await this.#closeSameOwner();
    } catch (cleanupFailure: unknown) {
      const failures = [...this.#failures, cleanupFailure];
      if (this.#cleanupProvesComplete(cleanupFailure)) {
        throw new AggregateError(
          failures,
          this.#cleanupFailureMessage,
        );
      }
      throw new IncompleteSameOwnerCleanupError(
        failures,
        this.#cleanupFailureMessage,
        this.#closeSameOwner,
        this.#cleanupProvesComplete,
        this.#cleanupOwnerIdentity,
      );
    }
  }
}

const MAX_SAME_OWNER_FAILURE_CLEANUP_ATTEMPTS = 2;

/**
 * Finishes cleanup after an operation failed while retaining its only owner
 * handle. Cleanup is retried at most once, and only through the exact closer
 * supplied by that owner. A replacement client or process is never created.
 */
export async function throwAfterSameOwnerCleanup(
  originalFailure: unknown,
  closeSameOwner: () => Promise<void>,
  cleanupFailureMessage: string,
  cleanupProvesComplete: (error: unknown) => boolean =
    authenticatedCleanupProvesComplete,
): Promise<never> {
  const cleanupFailures: unknown[] = [];
  let cleanupComplete = false;
  for (
    let attempt = 0;
    attempt < MAX_SAME_OWNER_FAILURE_CLEANUP_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await closeSameOwner();
      cleanupComplete = true;
      break;
    } catch (cleanupFailure: unknown) {
      cleanupFailures.push(cleanupFailure);
      if (cleanupProvesComplete(cleanupFailure)) {
        cleanupComplete = true;
        break;
      }
    }
  }
  if (cleanupFailures.length > 0) {
    const failures = [originalFailure, ...cleanupFailures];
    if (!cleanupComplete) {
      throw new IncompleteSameOwnerCleanupError(
        failures,
        cleanupFailureMessage,
        closeSameOwner,
        cleanupProvesComplete,
      );
    }
    throw new AggregateError(
      failures,
      cleanupFailureMessage,
    );
  }
  throw originalFailure;
}

/**
 * Hashes exact ordered UCI option declarations for caller-side pinning. The
 * runtime never substitutes this measured value for the expected digest.
 */
export function digestUciOptionDeclarations(
  declarations: readonly string[],
): string {
  for (const declaration of declarations) {
    if (
      declaration.length === 0
      || declaration.trim() !== declaration
      || !declaration.startsWith("option ")
      || /[\r\n\0]/u.test(declaration)
    ) {
      throw new RangeError(
        "UCI option declarations must be exact, trimmed, single-line option responses.",
      );
    }
  }
  return createHash("sha256")
    .update(JSON.stringify([...declarations]), "utf8")
    .digest("hex");
}

export interface UciEvaluationContextDigestInput {
  readonly optionsDigest: string;
  readonly runtimeContextSha256: string;
  readonly executableSha256: string;
  readonly processArgs?: readonly string[];
  readonly configuredOptions?: readonly UciOptionSetting[];
  readonly advertisedOptionsSha256?: string;
}

/** Binds actual UCI settings to authenticated code and runtime assets. */
export function deriveUciEvaluationContextDigest(
  input: UciEvaluationContextDigestInput,
): string {
  const options = sha256Digest(input.optionsDigest, "UCI options digest");
  const runtime = sha256Digest(
    input.runtimeContextSha256,
    "UCI runtime context SHA-256",
  );
  const executable = sha256Digest(
    input.executableSha256,
    "UCI executable SHA-256",
  );
  const args = (input.processArgs ?? []).map(processArgument);
  const configuredOptions = (input.configuredOptions ?? []).map(copyOption);
  const advertisedOptionsSha256 =
    input.advertisedOptionsSha256 === undefined
      ? null
      : sha256Digest(
          input.advertisedOptionsSha256,
          "Advertised UCI options SHA-256",
        );
  return createHash("sha256")
    .update(JSON.stringify({
      format: "drawbackengine-uci-evaluation-context-v1",
      executableSha256: executable,
      processArgs: args,
      optionsDigest: options,
      configuredOptions,
      advertisedOptionsSha256,
      runtimeContextSha256: runtime,
    }), "utf8")
    .digest("hex");
}

/**
 * Authenticates an executable before spawning it, initializes exactly one UCI
 * process, and verifies its pinned identity and configuration surface.
 */
export async function createAuthenticatedNodeUciEngine(
  input: AuthenticatedNodeUciEngineConfig,
): Promise<AuthenticatedNodeUciEngine> {
  const config = validateAndCopyConfig(input);
  const executable = await stageAuthenticatedExecutable(
    config.process.executablePath,
    config.executableSha256,
  );
  let transport: NodeProcessUciTransport | undefined;
  let client: UciClient | undefined;

  try {
    transport = new NodeProcessUciTransport({
      ...config.process,
      executablePath: executable.path,
    });
    client = new UciClient(transport, config.client);
    const identity = await client.initialize();
    if (identity.name !== config.engineIdentity.uciName) {
      throw new AuthenticatedNodeUciEngineError(
        "Initialized UCI engine name does not match the caller-pinned identity.",
      );
    }
    if (
      config.advertisedOptionsSha256 !== undefined
      && digestUciOptionDeclarations(identity.options)
        !== config.advertisedOptionsSha256
    ) {
      throw new AuthenticatedNodeUciEngineError(
        "Initialized UCI option declarations do not match the caller-pinned digest.",
      );
    }
    assertConfiguredOptions(client, config.client.options ?? []);

    const fingerprint = Object.freeze({
      engine: config.engineIdentity.engine,
      version: config.engineIdentity.version,
      optionsDigest: deriveUciEvaluationContextDigest({
        optionsDigest: config.optionsDigest,
        runtimeContextSha256: config.runtimeContextSha256,
        executableSha256: config.executableSha256,
        ...(config.process.args === undefined
          ? {}
          : { processArgs: config.process.args }),
        ...(config.client.options === undefined
          ? {}
          : { configuredOptions: config.client.options }),
        ...(config.advertisedOptionsSha256 === undefined
          ? {}
          : {
              advertisedOptionsSha256:
                config.advertisedOptionsSha256,
            }),
      }),
    });
    const publicFingerprint = [
      fingerprint.engine,
      fingerprint.version,
      config.executableSha256,
      fingerprint.optionsDigest,
    ].join(":");
    const frozenIdentity = Object.freeze({
      name: identity.name,
      author: identity.author,
      options: Object.freeze([...identity.options]),
    });
    const initializedClient = client;
    const close = retryableClose(() =>
      closeAuthenticatedEngine(
        initializedClient,
        undefined,
        () => executable.cleanup(),
      )
    );
    return Object.freeze({
      client: initializedClient,
      identity: frozenIdentity,
      fingerprint,
      executableSha256: config.executableSha256,
      publicFingerprint,
      close,
    });
  } catch (error: unknown) {
    return throwAfterSameOwnerCleanup(
      error,
      () =>
        closeAuthenticatedEngine(
          client,
          transport,
          () => executable.cleanup(),
        ),
      "UCI authentication failed and authenticated cleanup encountered failures.",
    );
  }
}

function retryableClose(closeOnce: () => Promise<void>): () => Promise<void> {
  let complete = false;
  let active: Promise<void> | undefined;
  return () => {
    if (complete) {
      return Promise.resolve();
    }
    if (active !== undefined) {
      return active;
    }
    const attempt = closeOnce();
    active = attempt;
    void attempt.then(
      () => {
        complete = true;
        if (active === attempt) {
          active = undefined;
        }
      },
      (error: unknown) => {
        if (
          active === attempt
          && error instanceof AuthenticatedNodeUciEngineCloseError
          && (
            !error.privateExecutableRemoved
            || !error.processTerminated
          )
        ) {
          active = undefined;
        }
      },
    );
    return attempt;
  };
}

function validateAndCopyConfig(
  input: AuthenticatedNodeUciEngineConfig,
): ValidatedAuthenticatedNodeUciEngineConfig {
  const executablePath = requiredText(
    input.process.executablePath,
    "UCI executable path",
  );
  const executableSha256 = sha256Digest(
    input.process.executableSha256,
    "UCI executable SHA-256",
  );
  const runtimeContextSha256 = sha256Digest(
    input.process.runtimeContextSha256,
    "UCI runtime context SHA-256",
  );
  const args = input.process.args?.map(processArgument);
  const cwd = input.process.cwd === undefined
    ? undefined
    : requiredText(input.process.cwd, "UCI process working directory");
  const shutdownTimeoutMs = optionalPositiveInteger(
    input.process.shutdownTimeoutMs,
    "UCI shutdown timeout",
  );
  const timeoutMs = optionalPositiveInteger(
    input.client?.timeoutMs,
    "UCI client timeout",
  );
  const options = input.client?.options?.map(copyOption);
  const engineIdentity = Object.freeze({
    uciName: requiredText(
      input.engineIdentity.uciName,
      "Expected UCI engine name",
    ),
    engine: fingerprintComponent(
      input.engineIdentity.engine,
      "Engine fingerprint name",
    ),
    version: fingerprintComponent(
      input.engineIdentity.version,
      "Engine fingerprint version",
    ),
  });
  const optionsDigest = sha256Digest(
    input.optionsDigest,
    "UCI options digest",
  );
  const advertisedOptionsSha256 =
    input.advertisedOptionsSha256 === undefined
      ? undefined
      : sha256Digest(
          input.advertisedOptionsSha256,
          "Advertised UCI options SHA-256",
        );

  return {
    process: {
      executablePath,
      ...(args === undefined ? {} : { args }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
    },
    executableSha256,
    runtimeContextSha256,
    client: {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(options === undefined ? {} : { options }),
    },
    engineIdentity,
    optionsDigest,
    ...(advertisedOptionsSha256 === undefined
      ? {}
      : { advertisedOptionsSha256 }),
  };
}

interface StagedAuthenticatedExecutable {
  readonly path: string;
  cleanup(): Promise<void>;
}

/**
 * Copies the caller-selected executable into a private directory and hashes
 * that exact copy before spawning it. This closes the source-path replacement
 * race. It does not claim to defend against another process running as the same
 * operating-system account and mutating the private staging directory.
 */
async function stageAuthenticatedExecutable(
  sourcePath: string,
  expectedSha256: string,
): Promise<StagedAuthenticatedExecutable> {
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "drawback-uci-"));
  } catch (error: unknown) {
    throw new UciExecutableIntegrityError(
      "Unable to create private UCI executable staging.",
      { cause: error },
    );
  }
  const stagedPath = join(
    directory,
    process.platform === "win32" ? "engine.exe" : "engine",
  );
  let actualSha256: string;
  try {
    await copyFile(sourcePath, stagedPath);
    await chmod(stagedPath, 0o700);
    actualSha256 = await hashFile(stagedPath);
  } catch (error: unknown) {
    return failExecutableStaging(
      directory,
      new UciExecutableIntegrityError(
        "Unable to verify configured UCI executable bytes.",
        { cause: error },
      ),
    );
  }
  if (actualSha256 !== expectedSha256) {
    return failExecutableStaging(
      directory,
      new UciExecutableIntegrityError(
        "Configured UCI executable SHA-256 mismatch against caller-pinned digest.",
      ),
    );
  }
  return Object.freeze({
    path: stagedPath,
    cleanup: () => removeStagedExecutable(directory),
  });
}

async function failExecutableStaging(
  directory: string,
  authenticationFailure: Error,
): Promise<never> {
  return throwAfterSameOwnerCleanup(
    authenticationFailure,
    () => removeStagedExecutable(directory),
    "UCI executable authentication failed and private cleanup encountered failures.",
  );
}

async function removeStagedExecutable(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error: unknown) {
    throw new UciExecutableIntegrityError(
      "Unable to remove the private authenticated UCI executable.",
      { cause: error },
    );
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

async function closeAuthenticatedEngine(
  client: UciClient | undefined,
  transport: NodeProcessUciTransport | undefined,
  cleanupExecutable: () => Promise<void>,
): Promise<void> {
  let shutdownFailure: unknown;
  let cleanupFailure: unknown;
  try {
    if (client === undefined) {
      await transport?.close();
    } else {
      await client.close();
    }
  } catch (error: unknown) {
    shutdownFailure = error;
  }
  try {
    await cleanupExecutable();
  } catch (error: unknown) {
    cleanupFailure = error;
  }
  const failures = [shutdownFailure, cleanupFailure].filter(
    (failure) => failure !== undefined,
  );
  if (failures.length > 0) {
    const privateExecutableRemoved = cleanupFailure === undefined;
    throw new AuthenticatedNodeUciEngineCloseError(
      privateExecutableRemoved
        ? "UCI engine shutdown failed after private executable cleanup."
        : "UCI engine shutdown or private executable cleanup failed.",
      privateExecutableRemoved,
      shutdownFailure === undefined
        || errorProvesUciProcessTerminated(shutdownFailure),
      {
        cause:
          failures.length === 1
            ? failures[0]
            : new AggregateError(
                failures,
                "UCI engine shutdown and executable cleanup both failed.",
              ),
      },
    );
  }
}

function authenticatedCleanupProvesComplete(error: unknown): boolean {
  return error instanceof AuthenticatedNodeUciEngineCloseError
    && error.privateExecutableRemoved
    && error.processTerminated;
}

function assertConfiguredOptions(
  client: UciClient,
  options: readonly UciOptionSetting[],
): void {
  for (const option of options) {
    if (
      option.value !== undefined
      && client.configuredOption(option.name) !== option.value
    ) {
      throw new AuthenticatedNodeUciEngineError(
        `Initialized UCI engine did not retain required option ${option.name}.`,
      );
    }
  }
}

function copyOption(option: UciOptionSetting): UciOptionSetting {
  const name = requiredText(option.name, "UCI option name");
  if (option.value === undefined) {
    return { name };
  }
  if (typeof option.value === "number" && !Number.isFinite(option.value)) {
    throw new RangeError("UCI option numeric values must be finite.");
  }
  if (
    typeof option.value === "string"
    && /[\r\n]/u.test(option.value)
  ) {
    throw new RangeError("UCI option string values must be single-line.");
  }
  return { name, value: option.value };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  return singleLineText(value, label);
}

function fingerprintComponent(value: unknown, label: string): string {
  const component = requiredText(value, label);
  if (component.includes(":")) {
    throw new RangeError(
      `${label} must not contain the public fingerprint delimiter (:).`,
    );
  }
  return component;
}

function singleLineText(value: string, label: string): string {
  if (
    value.length === 0
    || value.trim() !== value
    || /[\r\n\0]/u.test(value)
  ) {
    throw new RangeError(`${label} must be non-empty, trimmed, and single-line.`);
  }
  return value;
}

function processArgument(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("UCI process arguments must be strings.");
  }
  if (value.includes("\0")) {
    throw new RangeError("UCI process arguments must not contain NUL.");
  }
  return value;
}

function sha256Digest(value: unknown, label: string): string {
  const digest = requiredText(value, label);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return digest;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}
