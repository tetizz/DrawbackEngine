import { describe, expect, it } from "vitest";
import {
  createConstraintCacheRecord,
  validateCompletedPgnEvaluatorSidecar,
  type NodeUciTurnConstraintProviderConfig,
} from "@drawbackengine/chess-evaluator";
import type {
  ExternalTurnConstraintProvider,
  ExternalTurnConstraintRequest,
} from "@drawbackengine/drawback-engine";
import {
  generateCompletedPgnEvaluatorSidecarFromTrustedProvider,
} from "./pgn-evaluator-sidecar.js";

const OPTIONS_DIGEST = "12".repeat(32);
const EXECUTABLE_DIGEST = "34".repeat(32);
const PUBLIC_FINGERPRINT =
  `stockfish:17.1:${EXECUTABLE_DIGEST}:${OPTIONS_DIGEST}`;

function evaluator(): NodeUciTurnConstraintProviderConfig {
  return {
    process: {
      executablePath: "unused-in-unit-test",
      executableSha256: EXECUTABLE_DIGEST,
    },
    policy: {
      identity: { id: "stockfish-bestmove-v1", version: 1 },
      engineIdentity: {
        uciName: "Stockfish 17.1",
        engine: "stockfish",
        version: "17.1",
      },
      optionsDigest: OPTIONS_DIGEST,
      limit: { nodes: 10_000 },
    },
  };
}

class RecordingProvider implements ExternalTurnConstraintProvider {
  public readonly requests: ExternalTurnConstraintRequest[] = [];

  public async resolve(request: ExternalTurnConstraintRequest) {
    this.requests.push(request);
    const cacheRecord = await createConstraintCacheRecord(
      {
        policy: { id: request.policyId, version: 1 },
        fingerprint: {
          engine: "stockfish",
          version: "17.1",
          optionsDigest: OPTIONS_DIGEST,
        },
        fen: request.fen,
        rootMoves: request.ordinaryRootMoves,
        limit: { nodes: 10_000 },
      },
      request.ordinaryRootMoves[0] ?? null,
    );
    if (cacheRecord.bestMove === null) {
      throw new Error("Replay fixture unexpectedly has no legal root move.");
    }
    return {
      provider: "uci-best-move" as const,
      policyId: request.policyId,
      positionKey: request.positionKey,
      requestDigest: cacheRecord.requestDigest,
      bestMoveUci: cacheRecord.bestMove,
      engineFingerprint: PUBLIC_FINGERPRINT,
    };
  }

  public async dispose(): Promise<void> {
    await Promise.resolve();
  }
}

describe("completed-PGN evaluator sidecar generation", () => {
  it("resolves and authenticates exactly one evaluator fact per replay ply", async () => {
    const pgn = '[Result "1-0"]\n\n1. e4 e5 2. Nf3 1-0';
    const provider = new RecordingProvider();
    const generated =
      await generateCompletedPgnEvaluatorSidecarFromTrustedProvider({
      pgn,
      evaluator: evaluator(),
      provider,
    });

    expect(provider.requests).toHaveLength(3);
    expect(generated.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const validated = await validateCompletedPgnEvaluatorSidecar(
      generated.sidecar,
      pgn,
    );
    expect(validated.constraints).toHaveLength(3);
    expect(validated.constraints.every(
      ({ engineFingerprint }) => engineFingerprint === PUBLIC_FINGERPRINT,
    )).toBe(true);
  });

  it("rejects provider output bound to a different engine fingerprint", async () => {
    const provider = new RecordingProvider();
    const originalResolve = provider.resolve.bind(provider);
    provider.resolve = async (request) => ({
      ...await originalResolve(request),
      engineFingerprint: "wrong:engine:fingerprint",
    });

    await expect(generateCompletedPgnEvaluatorSidecarFromTrustedProvider({
      pgn: '[Result "1-0"]\n\n1. e4 1-0',
      evaluator: evaluator(),
      provider,
    })).rejects.toThrow("do not match replay ply 1");
  });
});
