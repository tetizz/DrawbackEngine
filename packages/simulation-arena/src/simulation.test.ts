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

  it("does not let parameter-generator draw counts shift agent moves", () => {
    const noisyParametersRule = {
      ...unrestrictedRule,
      id: "noisy-unrestricted",
      generateParameters(rng: Parameters<
        typeof unrestrictedRule.generateParameters
      >[0]) {
        for (let index = 0; index < 127; index += 1) {
          rng.next();
        }
        return {};
      },
    };
    const baseline = simulateGame({
      seed: 0x71a1_5eed,
      maxPlies: 20,
      rules: { white: unrestrictedRule, black: unrestrictedRule },
      whiteAgent: randomLegalAgent,
      blackAgent: randomLegalAgent,
    });
    const noisy = simulateGame({
      seed: 0x71a1_5eed,
      maxPlies: 20,
      rules: { white: noisyParametersRule, black: unrestrictedRule },
      whiteAgent: randomLegalAgent,
      blackAgent: randomLegalAgent,
    });

    expect(noisy.plies.map(({ observation }) => observation.move)).toEqual(
      baseline.plies.map(({ observation }) => observation.move),
    );
  });

  it("does not let one agent's RNG consumption shift either side's later moves", () => {
    const firstLegalAgent: SimulationAgent = {
      id: "first-legal",
      chooseMove(view) {
        const move = view.legalMoves[0];
        if (move === undefined) {
          throw new Error("Expected a legal move.");
        }
        return move;
      },
    };
    const noisyFirstLegalAgent: SimulationAgent = {
      id: "noisy-first-legal",
      chooseMove(view, rng) {
        for (let index = 0; index < 257; index += 1) {
          rng.next();
        }
        const move = view.legalMoves[0];
        if (move === undefined) {
          throw new Error("Expected a legal move.");
        }
        return move;
      },
    };
    const baseline = simulateGame({
      seed: 0xa63e_0175,
      maxPlies: 20,
      rules: { white: unrestrictedRule, black: unrestrictedRule },
      whiteAgent: firstLegalAgent,
      blackAgent: randomLegalAgent,
    });
    const noisy = simulateGame({
      seed: 0xa63e_0175,
      maxPlies: 20,
      rules: { white: unrestrictedRule, black: unrestrictedRule },
      whiteAgent: noisyFirstLegalAgent,
      blackAgent: randomLegalAgent,
    });

    expect(noisy.plies.map(({ observation }) => observation.move)).toEqual(
      baseline.plies.map(({ observation }) => observation.move),
    );
  });

  it("accepts seed zero and rejects seeds outside the serialized domain", () => {
    const config = {
      maxPlies: 1,
      rules: { white: unrestrictedRule, black: unrestrictedRule },
      whiteAgent: randomLegalAgent,
      blackAgent: randomLegalAgent,
    } as const;
    expect(simulateGame({ ...config, seed: 0 }).seed).toBe(0);
    expect(() => simulateGame({ ...config, seed: -1 })).toThrow(
      "unsigned 32-bit",
    );
    expect(() =>
      simulateGame({ ...config, seed: 0x1_0000_0000 }),
    ).toThrow("unsigned 32-bit");
  });
});
