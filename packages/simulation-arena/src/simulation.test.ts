import { describe, expect, it } from "vitest";
import { unrestrictedRule } from "@drawbackengine/drawback-engine";
import { randomLegalAgent, simulateGame, type SimulationAgent } from "./index.js";

const CI_TIMEOUT_MS = 15_000;

describe("simulateGame", () => {
  it(
    "replays identically for a fixed seed",
    () => {
      const config = {
        seed: 0xdecafbad,
        maxPlies: 40,
        rules: { white: unrestrictedRule, black: unrestrictedRule },
        whiteAgent: randomLegalAgent,
        blackAgent: randomLegalAgent,
      } as const;

      expect(simulateGame(config)).toEqual(simulateGame(config));
    },
    CI_TIMEOUT_MS,
  );

  it("runs a smoke game and records standard and drawback legal moves", () => {
    const game = simulateGame({
      seed: 42,
      maxPlies: 24,
      rules: { white: unrestrictedRule, black: unrestrictedRule },
      whiteAgent: randomLegalAgent,
      blackAgent: randomLegalAgent,
    });

    expect(game.plies).toHaveLength(24);
    expect(game.stoppedAtPlyLimit).toBe(true);
    expect(game.plies[0]?.observation.ordinaryLegalMoves).toHaveLength(20);
    expect(game.plies[0]?.observation.drawbackLegalMoves).toHaveLength(20);
  });

  it("never exposes either hidden drawback through an agent view", () => {
    const views: object[] = [];
    const inspectingAgent: SimulationAgent = {
      id: "view-inspector",
      chooseMove(view) {
        views.push(view);
        const move = view.legalMoves[0];
        if (move === undefined) {
          throw new Error("Expected at least one legal move.");
        }
        return move;
      },
    };

    simulateGame({
      seed: 7,
      maxPlies: 4,
      rules: { white: unrestrictedRule, black: unrestrictedRule },
      whiteAgent: inspectingAgent,
      blackAgent: inspectingAgent,
    });

    expect(views).not.toHaveLength(0);
    for (const view of views) {
      expect(view).not.toHaveProperty("drawback");
      expect(view).not.toHaveProperty("drawbacks");
      expect(view).not.toHaveProperty("rule");
      expect(view).not.toHaveProperty("parameters");
    }
  });

  it("rejects invalid ply limits", () => {
    expect(() =>
      simulateGame({
        seed: 1,
        maxPlies: 0,
        rules: { white: unrestrictedRule, black: unrestrictedRule },
        whiteAgent: randomLegalAgent,
        blackAgent: randomLegalAgent,
      }),
    ).toThrow(RangeError);
  });
});
