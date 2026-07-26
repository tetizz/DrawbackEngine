import { describe, expect, it } from "vitest";
import { parsePrivateSimulationTraceRecord } from "@drawbackengine/simulation-trace";
import {
  handAndGigabrainRule,
  unrestrictedRule,
  type ExternalTurnConstraint,
  type ExternalTurnConstraintProvider,
  type ExternalTurnConstraintRequest,
} from "@drawbackengine/drawback-engine";
import {
  asAsyncAgent,
  createPrivateSimulationTrace,
  randomLegalAgent,
  simulateGame,
  simulateGameAsync,
  type SimulationResult,
} from "./index.js";

class DeterministicConstraintProvider
  implements ExternalTurnConstraintProvider {
  public resolve(
    request: ExternalTurnConstraintRequest,
  ): Promise<ExternalTurnConstraint> {
    const bestMoveUci = request.ordinaryRootMoves[0];
    if (bestMoveUci === undefined) {
      throw new Error("Expected at least one ordinary move.");
    }
    return Promise.resolve({
      provider: request.provider,
      policyId: request.policyId,
      positionKey: request.positionKey,
      requestDigest: "ab".repeat(32),
      bestMoveUci,
      engineFingerprint: "trace-test-engine",
    });
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("simulation trace projection", () => {
  it("is deterministic and labels the active player's pre-move state", () => {
    const game = simulateGame({
      seed: 0x1234_5678,
      maxPlies: 8,
      rules: { white: unrestrictedRule, black: unrestrictedRule },
      whiteAgent: randomLegalAgent,
      blackAgent: randomLegalAgent,
    });
    const first = createPrivateSimulationTrace(game, 11);
    const second = createPrivateSimulationTrace(game, 11);

    expect(second).toEqual(first);
    expect(parsePrivateSimulationTraceRecord(first)).toEqual(first);
    expect(first.initialFen).toBe(game.initialFen);
    expect(first.plies[0]?.activeSecret).toEqual({
      drawbackId: "unrestricted",
      hiddenParameters: {},
      drawbackInternalState: { movesApplied: 0 },
    });
    expect(first.plies[0]?.move.uci).toMatch(
      /^[a-h][1-8][a-h][1-8][nbrq]?$/u,
    );
  });

  it("projects synchronous and asynchronous simulations identically", async () => {
    const config = {
      seed: 123,
      maxPlies: 12,
      rules: { white: unrestrictedRule, black: unrestrictedRule },
    } as const;
    const synchronous = simulateGame({
      ...config,
      whiteAgent: randomLegalAgent,
      blackAgent: randomLegalAgent,
    });
    const asynchronous = await simulateGameAsync({
      ...config,
      whiteAgent: asAsyncAgent(randomLegalAgent),
      blackAgent: asAsyncAgent(randomLegalAgent),
    });
    expect(createPrivateSimulationTrace(asynchronous, 0)).toEqual(
      createPrivateSimulationTrace(synchronous, 0),
    );
  });

  it("supports a zero-ply terminal trace", () => {
    const initialFen =
      "8/8/8/8/8/8/7k/K7 w - - 0 1";
    const game: SimulationResult = {
      seed: 0,
      plyLimit: 1,
      initialFen,
      finalFen: initialFen,
      result: { kind: "draw", reason: "insufficient material" },
      stoppedAtPlyLimit: false,
      drawbacks: { white: "unrestricted", black: "unrestricted" },
      agents: {
        white: { id: "random-legal", style: "random", strength: 100 },
        black: { id: "random-legal", style: "random", strength: 100 },
      },
      plies: [],
    };
    expect(createPrivateSimulationTrace(game, 0).plies).toEqual([]);
  });

  it("fails before publication when rule state is not JSON-safe", () => {
    const game = simulateGame({
      seed: 7,
      maxPlies: 1,
      rules: { white: unrestrictedRule, black: unrestrictedRule },
      whiteAgent: randomLegalAgent,
      blackAgent: randomLegalAgent,
    });
    const first = game.plies[0];
    if (first === undefined) {
      throw new Error("Expected a simulated move.");
    }
    const invalid: SimulationResult = {
      ...game,
      plies: [
        {
          ...first,
          drawback: {
            ...first.drawback,
            state: { invalid: () => "not JSON" },
          },
        },
      ],
    };
    expect(() => createPrivateSimulationTrace(invalid, 0)).toThrow(
      "JSON-safe",
    );
  });

  it("requires uniform evaluator coverage on prepared simulations", async () => {
    const game = await simulateGameAsync({
      seed: 17,
      maxPlies: 2,
      rules: {
        white: handAndGigabrainRule,
        black: handAndGigabrainRule,
      },
      whiteAgent: asAsyncAgent(randomLegalAgent),
      blackAgent: asAsyncAgent(randomLegalAgent),
      turnConstraintProvider: new DeterministicConstraintProvider(),
    });
    const trace = createPrivateSimulationTrace(game, 0);
    expect(trace.evaluatorCoverage).toBe("uniform");
    expect(
      trace.plies.every((ply) => ply.publicEvaluatorConstraint !== null),
    ).toBe(true);

    const first = game.plies[0];
    const second = game.plies[1];
    if (first === undefined || second === undefined) {
      throw new Error("Expected two prepared plies.");
    }
    const unenrichedObservation = { ...second.observation };
    delete unenrichedObservation.externalConstraint;
    const mixed: SimulationResult = {
      ...game,
      plies: [
        first,
        { ...second, observation: unenrichedObservation },
      ],
    };
    expect(() => createPrivateSimulationTrace(mixed, 0)).toThrow(
      "cannot mix evaluator-enriched and unenriched plies",
    );
  });
});
