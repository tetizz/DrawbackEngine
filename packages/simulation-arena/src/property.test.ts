import { describe, expect, it } from "vitest";
import {
  checkersRule,
  type DrawbackRule,
  spiceOfLifeRule,
  truantRule,
  veganRule,
} from "@drawbackengine/drawback-engine";
import { randomLegalAgent, simulateGame } from "./index.js";

function expectDeterministic<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
>(
  seed: number,
  rules: {
    readonly white: DrawbackRule<WhiteState, WhiteParameters>;
    readonly black: DrawbackRule<BlackState, BlackParameters>;
  },
): void {
  const config = {
    seed,
    maxPlies: 48,
    rules,
    whiteAgent: randomLegalAgent,
    blackAgent: randomLegalAgent,
  } as const;
  expect(simulateGame(config)).toEqual(simulateGame(config));
}

describe("simulation bounded properties", () => {
  it(
    "reproduces complete results for a matrix of fixed seeds and rule pairs",
    () => {
      for (const seed of [0, 1, 42, 0x7fffffff, 0xffffffff]) {
        expectDeterministic(seed, { white: veganRule, black: checkersRule });
        expectDeterministic(seed, {
          white: truantRule,
          black: spiceOfLifeRule,
        });
      }
    },
    15_000,
  );
});
