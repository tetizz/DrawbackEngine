import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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

/**
 * Authenticates an executable before spawning it, initializes exactly one UCI
 * process, and verifies its pinned identity and configuration surface.
 */
export async function createAuthenticatedNodeUciEngine(
  input: AuthenticatedNodeUciEngineConfig,
): Promise<AuthenticatedNodeUciEngine> {
  const config = validateAndCopyConfig(input);
  await verifyExecutable(
    config.process.executablePath,
    config.executableSha256,
  );
  const transport = new NodeProcessUciTransport(config.process);
  const client = new UciClient(transport, config.client);

  try {
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
      optionsDigest: config.optionsDigest,
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
    return Object.freeze({
      client,
      identity: frozenIdentity,
      fingerprint,
      executableSha256: config.executableSha256,
      publicFingerprint,
      close: () => client.close(),
    });
  } catch (error: unknown) {
    // Cleanup is best effort and must never hide the authentication error.
    await client.close().catch(() => undefined);
    throw error;
  }
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

async function verifyExecutable(
  executablePath: string,
  expectedSha256: string,
): Promise<void> {
  let actualSha256: string;
  try {
    actualSha256 = await hashFile(executablePath);
  } catch (error: unknown) {
    throw new UciExecutableIntegrityError(
      "Unable to verify configured UCI executable bytes.",
      { cause: error },
    );
  }
  if (actualSha256 !== expectedSha256) {
    throw new UciExecutableIntegrityError(
      "Configured UCI executable SHA-256 mismatch against caller-pinned digest.",
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
