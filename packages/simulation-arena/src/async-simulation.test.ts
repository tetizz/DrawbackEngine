import { describe, expect, it } from "vitest";
import {
  AsyncSessionPreparationError,
} from "@drawbackengine/chess-core";
import {
  checkersRule,
  handAndGigabrainRule,
  ichtyophobeRule,
  type ExternalTurnConstraint,
  type ExternalTurnConstraintProvider,
  type ExternalTurnConstraintRequest,
} from "@drawbackengine/drawback-engine";
import { simulateGameAsync, type AsyncSimulationAgent } from "./async-simulation.js";

class RecordingProvider implements ExternalTurnConstraintProvider {
  public readonly requests: ExternalTurnConstraintRequest[] = [];
  public failureAfter = Number.POSITIVE_INFINITY;
  public readonly failOnRequests = new Set<number>();

  public resolve(
    request: ExternalTurnConstraintRequest,
  ): Promise<ExternalTurnConstraint> {
    this.requests.push(request);
    if (
      this.requests.length > this.failureAfter ||
      this.failOnRequests.has(this.requests.length)
    ) {
      throw new Error("deliberate provider failure");
    }
    const preferred =
      request.ordinaryRootMoves.find((move) => move === "e2e4") ??
      request.ordinaryRootMoves.find((move) => move === "e7e5") ??
      request.ordinaryRootMoves[0];
    if (preferred === undefined) {
      throw new Error("Provider received an empty ordinary root mask.");
    }
    return Promise.resolve(
      Object.freeze({
        provider: request.provider,
        policyId: request.policyId,
        positionKey: request.positionKey,
        bestMoveUci: preferred,
        requestDigest: "ab".repeat(32),
        engineFingerprint: "test-engine",
      }),
    );
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

const firstLegalAgent: AsyncSimulationAgent = {
  id: "first-legal",
  chooseMove(view) {
    const move = view.legalMoves[0];
    if (move === undefined) {
      throw new Error("Agent received no legal moves.");
    }
    return Promise.resolve(move);
  },
};

describe("asynchronous simulation turn constraints", () => {
  it("simulates evaluator-backed rules from their prepared legal masks", async () => {
    const provider = new RecordingProvider();
    const inspectingAgent: AsyncSimulationAgent = {
      id: "prepared-mask-inspector",
      chooseMove(view) {
        expect(view.legalMoves).toHaveLength(16);
        expect(view.legalMoves.every((move) => move.piece === "pawn")).toBe(true);
        const move = view.legalMoves.find(
          (candidate) =>
            candidate.from === "e2" && candidate.to === "e4",
        );
        if (move === undefined) {
          throw new Error("Expected e2-e4 in the prepared pawn mask.");
        }
        return Promise.resolve(move);
      },
    };

    const game = await simulateGameAsync({
      seed: 71,
      maxPlies: 1,
      rules: {
        white: handAndGigabrainRule,
        black: ichtyophobeRule,
      },
      whiteAgent: inspectingAgent,
      blackAgent: firstLegalAgent,
      turnConstraintProvider: provider,
    });

    expect(game.plies).toHaveLength(1);
    expect(game.plies[0]?.observation.move.san).toBe("e4");
    expect(game.plies[0]?.observation.externalConstraint).toMatchObject({
      bestMoveUci: "e2e4",
      engineFingerprint: "test-engine",
    });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.ordinaryRootMoves).toHaveLength(20);
    expect(provider.requests[1]?.fen).toBe(game.finalFen);
  });

  it("reports a provider failure after a move as an applied-move preparation error", async () => {
    const provider = new RecordingProvider();
    provider.failureAfter = 1;

    try {
      await simulateGameAsync({
        seed: 72,
        maxPlies: 1,
        rules: {
          white: handAndGigabrainRule,
          black: ichtyophobeRule,
        },
        whiteAgent: firstLegalAgent,
        blackAgent: firstLegalAgent,
        turnConstraintProvider: provider,
      });
      throw new Error("Expected simulation to reject.");
    } catch (error) {
      expect(error).toBeInstanceOf(AsyncSessionPreparationError);
      if (!(error instanceof AsyncSessionPreparationError)) {
        throw error;
      }
      expect(error.moveApplied).toBe(true);
      expect(error.message).toContain("could not recover");
      expect(provider.requests).toHaveLength(3);
    }
  });

  it("records an applied ply after a transient next-turn provider failure", async () => {
    const provider = new RecordingProvider();
    provider.failOnRequests.add(2);

    const game = await simulateGameAsync({
      seed: 74,
      maxPlies: 1,
      rules: {
        white: handAndGigabrainRule,
        black: ichtyophobeRule,
      },
      whiteAgent: firstLegalAgent,
      blackAgent: firstLegalAgent,
      turnConstraintProvider: provider,
    });

    expect(provider.requests).toHaveLength(3);
    expect(game.plies).toHaveLength(1);
    expect(game.plies[0]?.observation.move).toMatchObject({
      from: "a2",
      to: "a3",
    });
    expect(game.finalFen).toBe(game.plies[0]?.observation.fenAfter);
    expect(game.stoppedAtPlyLimit).toBe(true);
  });

  it("records the same public evaluator fact for a synchronous true rule", async () => {
    const provider = new RecordingProvider();

    const game = await simulateGameAsync({
      seed: 75,
      maxPlies: 1,
      rules: {
        white: checkersRule,
        black: checkersRule,
      },
      whiteAgent: firstLegalAgent,
      blackAgent: firstLegalAgent,
      turnConstraintProvider: provider,
    });

    expect(game.plies[0]?.observation.externalConstraint).toMatchObject({
      bestMoveUci: "e2e4",
      engineFingerprint: "test-engine",
    });
    expect(provider.requests).toHaveLength(2);
  });

  it("fails closed when an evaluator-backed rule has no provider", async () => {
    await expect(
      simulateGameAsync({
        seed: 73,
        maxPlies: 1,
        rules: {
          white: handAndGigabrainRule,
          black: checkersRule,
        },
        whiteAgent: firstLegalAgent,
        blackAgent: firstLegalAgent,
      }),
    ).rejects.toMatchObject({
      name: "AsyncSessionPreparationError",
      moveApplied: false,
    });
  });
});
