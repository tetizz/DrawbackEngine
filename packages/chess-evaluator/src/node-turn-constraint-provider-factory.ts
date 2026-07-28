import {
  createAuthenticatedNodeUciEngine,
  type SerializableUciEngineIdentity,
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
  UciSearchLimit,
} from "./types.js";

export type { SerializableUciEngineIdentity };
export { UciExecutableIntegrityError };

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
  const identity = {
    id: requiredText(input.policy.identity.id, "Constraint policy ID"),
    version: positiveInteger(
      input.policy.identity.version,
      "Constraint policy version",
    ),
  };
  const limit = copyLimit(input.policy.limit);
  const engine = await createAuthenticatedNodeUciEngine({
    process: input.process,
    ...(input.client === undefined ? {} : { client: input.client }),
    engineIdentity: input.policy.engineIdentity,
    optionsDigest: input.policy.optionsDigest,
  });

  try {
    return new UciTurnConstraintProvider({
      client: engine.client,
      policy: createProviderPolicy(identity, limit, engine),
    });
  } catch (error: unknown) {
    await engine.close().catch(() => undefined);
    throw error;
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
