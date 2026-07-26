import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { UciClient } from "./client.js";
import type {
  ConstraintEngineFingerprint,
  ConstraintPolicyIdentity,
} from "./constraint-cache.js";
import {
  NodeProcessUciTransport,
  type NodeProcessTransportOptions,
} from "./node-process-transport.js";
import {
  UciTurnConstraintProvider,
  type UciTurnConstraintPolicy,
} from "./turn-constraint-provider.js";
import type {
  UciClientOptions,
  UciOptionSetting,
  UciSearchLimit,
} from "./types.js";

export interface SerializableUciEngineIdentity {
  /** Exact value expected from the engine's `id name` response. */
  readonly uciName: string;
  /** Stable engine family used in cache provenance. */
  readonly engine: string;
  /** Caller-pinned engine build/version used in cache provenance. */
  readonly version: string;
}

export interface NodeUciTurnConstraintProviderConfig {
  readonly process: NodeProcessTransportOptions & {
    /** Expected SHA-256 of the executable file bytes, verified before spawn. */
    readonly executableSha256: string;
  };
  readonly client?: UciClientOptions;
  readonly policy: {
    readonly identity: ConstraintPolicyIdentity;
    readonly engineIdentity: SerializableUciEngineIdentity;
    /**
     * Canonical caller-owned digest of every evaluation-affecting UCI option.
     * The factory deliberately does not infer or recompute this provenance.
     */
    readonly optionsDigest: string;
    readonly limit: UciSearchLimit;
  };
}

/**
 * Creates an initialized, process-backed constraint provider from data that can
 * cross a worker boundary. The returned provider owns the spawned process and
 * callers must dispose it.
 */
export async function createNodeUciTurnConstraintProvider(
  input: NodeUciTurnConstraintProviderConfig,
): Promise<UciTurnConstraintProvider> {
  const config = validateAndCopyConfig(input);
  await verifyExecutable(
    config.process.executablePath,
    config.executableSha256,
  );
  const transport = new NodeProcessUciTransport(config.process);
  const client = new UciClient(transport, config.client);

  try {
    await client.initialize();
    return new UciTurnConstraintProvider({
      client,
      policy: createProviderPolicy(config),
    });
  } catch (error) {
    // Cleanup is best effort and must never hide the initialization or identity
    // error that explains why the factory failed.
    await client.close().catch(async () => {
      await transport.close().catch(() => undefined);
    });
    throw error;
  }
}

interface ValidatedConfig {
  readonly process: NodeProcessTransportOptions;
  readonly executableSha256: string;
  readonly client: UciClientOptions;
  readonly policy: NodeUciTurnConstraintProviderConfig["policy"];
}

function validateAndCopyConfig(
  input: NodeUciTurnConstraintProviderConfig,
): ValidatedConfig {
  const executablePath = requiredText(
    input.process.executablePath,
    "UCI executable path",
  );
  const executableSha256 = sha256Digest(
    input.process.executableSha256,
    "UCI executable SHA-256",
  );
  const args = input.process.args?.map((argument) =>
    processArgument(argument)
  );
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
  const identity = {
    id: requiredText(input.policy.identity.id, "Constraint policy ID"),
    version: positiveInteger(
      input.policy.identity.version,
      "Constraint policy version",
    ),
  };
  const engineIdentity = {
    uciName: requiredText(
      input.policy.engineIdentity.uciName,
      "Expected UCI engine name",
    ),
    engine: fingerprintComponent(
      input.policy.engineIdentity.engine,
      "Engine fingerprint name",
    ),
    version: fingerprintComponent(
      input.policy.engineIdentity.version,
      "Engine fingerprint version",
    ),
  };
  const optionsDigest = sha256Digest(
    input.policy.optionsDigest,
    "UCI options digest",
  );
  const limit = copyLimit(input.policy.limit);

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
    policy: {
      identity,
      engineIdentity,
      optionsDigest,
      limit,
    },
  };
}

function createProviderPolicy(config: ValidatedConfig): UciTurnConstraintPolicy {
  const fingerprint: ConstraintEngineFingerprint = {
    engine: config.policy.engineIdentity.engine,
    version: config.policy.engineIdentity.version,
    optionsDigest: config.policy.optionsDigest,
  };
  return {
    identity: config.policy.identity,
    fingerprint,
    expectedUciName: config.policy.engineIdentity.uciName,
    publicEngineFingerprint: [
      fingerprint.engine,
      fingerprint.version,
      config.executableSha256,
      fingerprint.optionsDigest,
    ].join(":"),
    limit: config.policy.limit,
  };
}

export class UciExecutableIntegrityError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UciExecutableIntegrityError";
  }
}

async function verifyExecutable(
  executablePath: string,
  expectedSha256: string,
): Promise<void> {
  let actualSha256: string;
  try {
    actualSha256 = await hashFile(executablePath);
  } catch (error) {
    throw new UciExecutableIntegrityError(
      `Unable to verify UCI executable bytes at ${executablePath}.`,
      { cause: error },
    );
  }
  if (actualSha256 !== expectedSha256) {
    throw new UciExecutableIntegrityError(
      `UCI executable SHA-256 mismatch at ${executablePath}.`,
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

function copyOption(option: UciOptionSetting): UciOptionSetting {
  const name = requiredText(option.name, "UCI option name");
  if (option.value === undefined) {
    return { name };
  }
  if (
    typeof option.value === "number"
    && !Number.isFinite(option.value)
  ) {
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

function copyLimit(limit: UciSearchLimit): UciSearchLimit {
  if ("depth" in limit) {
    return { depth: positiveInteger(limit.depth, "UCI search depth") };
  }
  if ("moveTimeMs" in limit) {
    return {
      moveTimeMs: positiveInteger(
        limit.moveTimeMs,
        "UCI search move time",
      ),
    };
  }
  if ("nodes" in limit) {
    return { nodes: positiveInteger(limit.nodes, "UCI search node count") };
  }
  throw new TypeError("UCI search limit has an unsupported shape.");
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
  // Arguments are passed directly with shell:false. Newlines and empty
  // arguments are legitimate argv values (notably for `node -e` test engines);
  // only NUL cannot be represented by the OS process API.
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
