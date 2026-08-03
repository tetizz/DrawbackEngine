import { replayCompletedPgn } from "@drawbackengine/chess-core";
import {
  buildCompletedPgnEvaluatorSidecar,
  createConstraintCacheRecord,
  deriveUciEvaluationContextDigest,
  type CompletedPgnEvaluatorPolicy,
  type CompletedPgnEvaluatorSidecar,
  type ConstraintCacheRecord,
  type NodeUciTurnConstraintProviderConfig,
} from "@drawbackengine/chess-evaluator";
import {
  createEvaluatorTurnConstraintRequest,
  type ExternalTurnConstraintProvider,
} from "@drawbackengine/drawback-engine";

export interface CompletedPgnSidecarGenerationInput {
  readonly pgn: string;
  readonly evaluator: NodeUciTurnConstraintProviderConfig;
  readonly provider: ExternalTurnConstraintProvider;
  readonly signal?: AbortSignal;
}

export interface CompletedPgnSidecarGenerationResult {
  readonly sidecar: CompletedPgnEvaluatorSidecar;
  readonly sha256: string;
}

function canonicalPolicy(
  evaluator: NodeUciTurnConstraintProviderConfig,
): CompletedPgnEvaluatorPolicy {
  const { executableSha256 } = evaluator.process;
  const { identity, engineIdentity, optionsDigest, limit } = evaluator.policy;
  const evaluationContextDigest = deriveUciEvaluationContextDigest({
    optionsDigest,
    runtimeContextSha256: evaluator.process.runtimeContextSha256,
    executableSha256,
    advertisedOptionsSha256: evaluator.policy.advertisedOptionsSha256,
    ...(evaluator.process.args === undefined
      ? {}
      : { processArgs: evaluator.process.args }),
    ...(evaluator.client?.options === undefined
      ? {}
      : { configuredOptions: evaluator.client.options }),
  });
  const searchLimit =
    "depth" in limit
      ? { kind: "depth" as const, value: limit.depth }
      : "moveTimeMs" in limit
        ? { kind: "move-time-ms" as const, value: limit.moveTimeMs }
        : { kind: "nodes" as const, value: limit.nodes };
  return Object.freeze({
    provider: "uci-best-move",
    id: identity.id,
    version: identity.version,
    engine: Object.freeze({
      uciName: engineIdentity.uciName,
      engine: engineIdentity.engine,
      version: engineIdentity.version,
      executableSha256,
      optionsDigest: evaluationContextDigest,
      publicFingerprint: [
        engineIdentity.engine,
        engineIdentity.version,
        executableSha256,
        evaluationContextDigest,
      ].join(":"),
    }),
    searchLimit: Object.freeze(searchLimit),
  });
}

/**
 * Builds a sidecar from a provider whose executable identity was authenticated
 * by createNodeUciTurnConstraintProvider. Test doubles are permitted only for
 * deterministic unit tests and are not an engine-authenticity boundary.
 */
export async function generateCompletedPgnEvaluatorSidecarFromTrustedProvider(
  input: CompletedPgnSidecarGenerationInput,
): Promise<CompletedPgnSidecarGenerationResult> {
  const replay = replayCompletedPgn(input.pgn);
  const policy = canonicalPolicy(input.evaluator);
  const records: ConstraintCacheRecord[] = [];

  for (const step of replay.steps) {
    throwIfAborted(input.signal);
    const request = createEvaluatorTurnConstraintRequest(
      {
        fen: step.fenBefore,
        turn: step.color,
        ply: step.ply - 1,
        history: step.historyBefore,
      },
      step.ordinaryLegalMoves,
    );
    if (request.policyId !== policy.id) {
      throw new Error(
        "Evaluator configuration does not implement the replay request policy.",
      );
    }
    const constraint = await input.provider.resolve(
      request,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    const record = await createConstraintCacheRecord(
      {
        policy: {
          id: policy.id,
          version: policy.version,
        },
        fingerprint: {
          engine: policy.engine.engine,
          version: policy.engine.version,
          optionsDigest: policy.engine.optionsDigest,
        },
        fen: request.fen,
        rootMoves: request.ordinaryRootMoves,
        limit: input.evaluator.policy.limit,
      },
      constraint.bestMoveUci,
    );
    if (
      (constraint as { readonly provider: unknown }).provider !==
        policy.provider ||
      constraint.policyId !== policy.id ||
      constraint.positionKey !== request.positionKey ||
      constraint.requestDigest !== record.requestDigest ||
      constraint.engineFingerprint !== policy.engine.publicFingerprint
    ) {
      throw new Error(
        `Evaluator returned facts that do not match replay ply ${String(step.ply)}.`,
      );
    }
    records.push(record);
  }

  return buildCompletedPgnEvaluatorSidecar({
    pgn: input.pgn,
    policy,
    records,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Completed-PGN evaluator generation was interrupted.");
  }
}
