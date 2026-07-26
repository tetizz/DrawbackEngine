import { describe, expect, it } from "vitest";
import { unrestrictedRule } from "@drawbackengine/drawback-engine";
import { randomLegalAgent } from "./simulation.js";
import { deriveGameSeed, simulateBatch } from "./batch.js";

describe("simulation batches", () => {
  it("derives stable and distinct game seeds", () => {
    expect(deriveGameSeed(42, 0)).toBe(deriveGameSeed(42, 0));
    expect(deriveGameSeed(42, 0)).not.toBe(deriveGameSeed(42, 1));
  });

  it("reproduces a complete batch", () => {
    const config = {
      seed: 55,
      games: 3,
      maxPlies: 12,
      rules: { white: unrestrictedRule, black: unrestrictedRule },
      whiteAgent: randomLegalAgent,
      blackAgent: randomLegalAgent,
    } as const;
    expect(simulateBatch(config)).toEqual(simulateBatch(config));
  });
});
