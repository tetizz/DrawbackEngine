import { describe, expect, it } from "vitest";
import {
  unrestrictedRule,
  type ChessMove,
} from "@drawbackengine/drawback-engine";
import {
  drawbackMaterialEvaluator,
} from "@drawbackengine/drawback-search";
import {
  createPlayerPrivateSearchAgent,
  resolvePlayerPrivateRule,
  simulatePlayerPrivateGame,
  type PlayerPrivateAgentView,
  type PlayerPrivateSimulationAgent,
} from "./index.js";

const searchAgent = createPlayerPrivateSearchAgent({
  id: "material-drawback-search",
  evaluator: drawbackMaterialEvaluator,
  limits: {
    maxDepth: 1,
    maxNodes: 5_000,
  },
  temperature: {
    temperatureCp: 1,
  },
  strength: 1_200,
});

describe("player-private capturable-king simulation", () => {
  it("plays a direct king capture and records the authority result", async () => {
    const game = await simulatePlayerPrivateGame({
      seed: 17,
      fen: "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
      maxPlies: 1,
      rules: {
        white: unrestrictedRule,
        black: resolvePlayerPrivateRule("triple-play"),
      },
      whiteAgent: searchAgent,
      blackAgent: searchAgent,
    });

    expect(game.authorityId).toBe("capturable-king/v1");
    expect(game.hypothesisPolicyId).toBe("unrestricted-baseline/v1");
    expect(game.agents.white.searchPolicy).toMatchObject({
      policyId: "material-drawback-search",
      evaluatorId: "drawback-material/v1",
      maxDepth: 1,
      maxNodes: 5_000,
      temperatureCp: 1,
    });
    expect(game.result).toEqual({
      kind: "king-capture",
      winner: "white",
      capturedKing: "black",
      method: "direct",
    });
    expect(game.plies[0]?.observation.move).toMatchObject({
      from: "e7",
      to: "e8",
      captured: "king",
    });
    expect(game.drawbackSecrets.initial.black.drawbackId).toBe(
      "triple-play",
    );
    expect(game.drawbackSecrets.initial.black.parameters).toHaveProperty(
      "requiredType",
    );
  });

  it("is deterministic and gives callbacks no raw opponent secret", async () => {
    const seenViews: PlayerPrivateAgentView[] = [];
    const inspectingAgent: PlayerPrivateSimulationAgent = {
      id: "public-boundary-inspector",
      async chooseMove(view) {
        seenViews.push(view);
        const move = view.legalMoves[0];
        if (move === undefined) {
          throw new Error("Expected a legal move.");
        }
        return Promise.resolve(move);
      },
    };
    const config = {
      seed: 0x51ec_7eed,
      maxPlies: 6,
      rules: {
        white: unrestrictedRule,
        black: unrestrictedRule,
      },
      whiteAgent: inspectingAgent,
      blackAgent: inspectingAgent,
    } as const;

    const first = await simulatePlayerPrivateGame(config);
    const second = await simulatePlayerPrivateGame(config);

    expect(second).toEqual(first);
    expect(seenViews.length).toBeGreaterThan(0);
    for (const view of seenViews) {
      expect(Object.keys(view).sort()).toEqual([
        "color",
        "legalMoves",
        "opponent",
        "own",
        "ply",
        "trace",
      ]);
      expect(view).not.toHaveProperty("session");
      expect(view).not.toHaveProperty("rules");
      expect(view).not.toHaveProperty("parameters");
      expect(view).not.toHaveProperty("state");
      expect(view).not.toHaveProperty("seed");
      expect(JSON.stringify(view.opponent)).not.toMatch(
        /parameters|state|secret|reveal/u,
      );
    }
  });

  it("fails rather than calling an agent after a terminal initial loss", async () => {
    let calls = 0;
    const agent: PlayerPrivateSimulationAgent = {
      id: "must-not-run",
      chooseMove() {
        calls += 1;
        return Promise.resolve({} as ChessMove);
      },
    };
    const noMovesRule = {
      ...unrestrictedRule,
      id: "no-moves",
      filterLegalMoves: () => [],
    };

    const game = await simulatePlayerPrivateGame({
      seed: 9,
      maxPlies: 2,
      rules: {
        white: noMovesRule,
        black: unrestrictedRule,
      },
      whiteAgent: agent,
      blackAgent: agent,
    });

    expect(calls).toBe(0);
    expect(game.result.kind).toBe("drawback-loss");
  });

  it.each([
    {
      name: "Truant",
      ruleId: "truant" as const,
      assertMask: (moves: readonly ChessMove[]) => {
        expect(moves.every((move) => move.from !== "e4")).toBe(true);
      },
    },
    {
      name: "Spice of Life",
      ruleId: "spice-of-life" as const,
      assertMask: (moves: readonly ChessMove[]) => {
        expect(moves.every((move) => move.piece !== "pawn")).toBe(true);
      },
    },
  ])("advances $name state before the player's next turn", async ({
    ruleId,
    assertMask,
  }) => {
    let checkedSecondWhiteTurn = false;
    const scriptedAgent: PlayerPrivateSimulationAgent = {
      id: "state-transition-script",
      chooseMove(view) {
        if (view.ply === 0) {
          return Promise.resolve(requiredMove(view, "e2", "e4"));
        }
        if (view.ply === 1) {
          return Promise.resolve(requiredMove(view, "a7", "a6"));
        }
        if (view.color === "white") {
          assertMask(view.legalMoves);
          checkedSecondWhiteTurn = true;
        }
        const move = view.legalMoves[0];
        if (move === undefined) {
          throw new Error("Expected a legal scripted move.");
        }
        return Promise.resolve(move);
      },
    };

    await simulatePlayerPrivateGame({
      seed: 73,
      maxPlies: 3,
      rules: {
        white: resolvePlayerPrivateRule(ruleId),
        black: unrestrictedRule,
      },
      whiteAgent: scriptedAgent,
      blackAgent: scriptedAgent,
    });

    expect(checkedSecondWhiteTurn).toBe(true);
  });

  it("fails closed on an empty public opponent posterior", async () => {
    await expect(
      simulatePlayerPrivateGame({
        seed: 88,
        maxPlies: 1,
        rules: {
          white: unrestrictedRule,
          black: unrestrictedRule,
        },
        whiteAgent: searchAgent,
        blackAgent: searchAgent,
        opponentHypotheses: {
          id: "empty-test/v1",
          hypotheses: () => [],
        },
      }),
    ).rejects.toThrow("no public opponent hypotheses");
  });

  it("rejects an agent move outside the exact coordinator mask", async () => {
    const invalidAgent: PlayerPrivateSimulationAgent = {
      id: "invalid-move-test",
      chooseMove() {
        return Promise.resolve({
          from: "a1",
          to: "a8",
          color: "white",
          piece: "rook",
          san: "Ra8",
          flags: "",
        });
      },
    };
    await expect(
      simulatePlayerPrivateGame({
        seed: 89,
        maxPlies: 1,
        rules: {
          white: unrestrictedRule,
          black: unrestrictedRule,
        },
        whiteAgent: invalidAgent,
        blackAgent: invalidAgent,
      }),
    ).rejects.toThrow("invalid move");
  });

  it("snapshots executable search options with their provenance", async () => {
    const mutableLimits = {
      maxDepth: 1,
      maxNodes: 5_000,
    };
    const mutableTemperature = {
      temperatureCp: 1,
    };
    const agent = createPlayerPrivateSearchAgent({
      id: "immutable-policy-test",
      evaluator: drawbackMaterialEvaluator,
      limits: mutableLimits,
      temperature: mutableTemperature,
    });
    mutableLimits.maxNodes = 1;
    mutableTemperature.temperatureCp = 0;

    const game = await simulatePlayerPrivateGame({
      seed: 90,
      fen: "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
      maxPlies: 1,
      rules: {
        white: unrestrictedRule,
        black: unrestrictedRule,
      },
      whiteAgent: agent,
      blackAgent: agent,
    });

    expect(game.result.kind).toBe("king-capture");
    expect(game.agents.white.searchPolicy).toMatchObject({
      maxNodes: 5_000,
      temperatureCp: 1,
    });
  });
});

function requiredMove(
  view: PlayerPrivateAgentView,
  from: string,
  to: string,
): ChessMove {
  const move = view.legalMoves.find(
    (candidate) => candidate.from === from && candidate.to === to,
  );
  if (move === undefined) {
    throw new Error(`Expected ${from}-${to} to be legal.`);
  }
  return move;
}
