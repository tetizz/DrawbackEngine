import {
  createAuthenticatedNodeUciEngine,
  type SerializableUciEngineIdentity,
  throwAfterSameOwnerCleanup,
  UciExecutableIntegrityError,
} from "./authenticated-node-uci-engine.js";
import type { ConstraintPolicyIdentity } from "./constraint-cache.js";
import type { NodeProcessTransportOptions } from "./node-process-transport.js";
import {
  UciTurnConstraintProvider,
  type UciTurnConstraintPolicy,
} from "./turn-constraint-provider.js";
import type {
  UciClientOptions,
  UciOptionSetting,
  UciSearchLimit,
} from "./types.js";

export type { SerializableUciEngineIdentity };
export { UciExecutableIntegrityError };

export interface NodeUciTurnConstraintProviderConfig {
  readonly process: NodeProcessTransportOptions & {
    /** Expected SHA-256 of the executable file bytes, verified before spawn. */
    readonly executableSha256: string;
    /** Digest of semantic arguments and every cwd-resolved runtime asset. */
    readonly runtimeContextSha256: string;
  };
  readonly client?: UciClientOptions;
  readonly policy: {
    readonly identity: ConstraintPolicyIdentity;
    readonly engineIdentity: SerializableUciEngineIdentity;
    /** Exact digest of the ordered UCI option declarations. */
    readonly advertisedOptionsSha256: string;
    /**
     * Canonical caller-owned digest of every evaluation-affecting UCI option.
     * The factory deliberately does not infer or recompute this provenance.
     */
    readonly optionsDigest: string;
    readonly limit: UciSearchLimit;
  };
}

/**
 * Creates an initialized, process-backed constraint provider in the process
 * that owns the executable configuration. Private paths and process settings
 * must not cross a worker boundary. Callers must dispose the returned owner.
 */
export async function createNodeUciTurnConstraintProvider(
  input: NodeUciTurnConstraintProviderConfig,
): Promise<UciTurnConstraintProvider> {
  const identity = {
    id: requiredText(input.policy.identity.id, "Constraint policy ID"),
    version: positiveInteger(
      input.policy.identity.version,
      "Constraint policy version",
    ),
  };
  const limit = copyLimit(input.policy.limit);
  assertDeterministicStockfishPolicy(
    input.policy.engineIdentity,
    input.client,
  );
  const engine = await createAuthenticatedNodeUciEngine({
    process: input.process,
    ...(input.client === undefined ? {} : { client: input.client }),
    engineIdentity: input.policy.engineIdentity,
    optionsDigest: input.policy.optionsDigest,
    advertisedOptionsSha256: input.policy.advertisedOptionsSha256,
  });

  try {
    return new UciTurnConstraintProvider({
      client: engine.client,
      policy: createProviderPolicy(identity, limit, engine),
      dispose: () => engine.close(),
    });
  } catch (error: unknown) {
    return throwAfterSameOwnerCleanup(
      error,
      () => engine.close(),
      "Constraint provider construction failed and authenticated cleanup encountered failures.",
    );
  }
}

function assertDeterministicStockfishPolicy(
  identity: SerializableUciEngineIdentity,
  client: UciClientOptions | undefined,
): void {
  if (identity.engine !== "stockfish") {
    return;
  }
  const options = new Map<string, UciOptionSetting["value"]>();
  for (const option of client?.options ?? []) {
    const name = requiredText(option.name, "UCI option name");
    const key = name.toLowerCase();
    if (options.has(key)) {
      throw new RangeError(`Duplicate deterministic UCI option ${name}.`);
    }
    options.set(key, option.value);
  }
  requireExactOption(options, "Threads", 1);
  const hash = options.get("hash");
  if (typeof hash !== "number" || !Number.isSafeInteger(hash) || hash <= 0) {
    throw new RangeError(
      "Deterministic Stockfish policy requires a positive integer Hash.",
    );
  }
  requireExactOption(options, "Ponder", false);
  requireExactOption(options, "MultiPV", 1);
  requireExactOption(options, "UCI_Chess960", false);
  requireExactOption(options, "UCI_LimitStrength", false);
  requireExactOption(options, "Skill Level", 20);
  requireExactOption(options, "SyzygyPath", "<empty>");
  if (!options.has("clear hash") || options.get("clear hash") !== undefined) {
    throw new RangeError(
      "Deterministic Stockfish policy requires the Clear Hash button.",
    );
  }
}

function requireExactOption(
  options: ReadonlyMap<string, UciOptionSetting["value"]>,
  name: string,
  value: string | number | boolean,
): void {
  const key = name.toLowerCase();
  if (!options.has(key) || options.get(key) !== value) {
    throw new RangeError(
      `Deterministic Stockfish policy requires ${name}=${String(value)}.`,
    );
  }
}

function createProviderPolicy(
  identity: ConstraintPolicyIdentity,
  limit: UciSearchLimit,
  engine: Awaited<ReturnType<typeof createAuthenticatedNodeUciEngine>>,
): UciTurnConstraintPolicy {
  return {
    identity,
    fingerprint: engine.fingerprint,
    expectedUciName: engine.identity.name,
    publicEngineFingerprint: engine.publicFingerprint,
    limit,
  };
}

function copyLimit(limit: UciSearchLimit): UciSearchLimit {
  if ("nodes" in limit) {
    return { nodes: positiveInteger(limit.nodes, "UCI search node count") };
  }
  throw new TypeError(
    "Deterministic turn constraints require a fixed node search limit.",
  );
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  if (
    value.length === 0
    || value.trim() !== value
    || /[\r\n\0]/u.test(value)
  ) {
    throw new RangeError(`${label} must be non-empty, trimmed, and single-line.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}
