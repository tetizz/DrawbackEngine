import { describe, expect, it } from "vitest";
import {
  gamblerRule,
  justPassingThroughRule,
  untitledDuckDrawbackRule,
  type DrawbackRule,
  type ParameterizedRuleState,
} from "@drawbackengine/drawback-engine";
import { randomLegalAgent, simulateGame } from "./simulation.js";

const SEEDS = [3, 29, 0x12345678] as const;
const MAX_PLIES = 20;
const CI_TIMEOUT_MS = 15_000;

function simulateParameterized<Parameters>(
  rule: DrawbackRule<ParameterizedRuleState, Parameters>,
  seed: number,
) {
  return simulateGame({
    seed,
    maxPlies: MAX_PLIES,
    rules: { white: rule, black: rule },
    whiteAgent: randomLegalAgent,
    blackAgent: randomLegalAgent,
  });
}

function expectFullGameDeterminism<Parameters>(
  rule: DrawbackRule<ParameterizedRuleState, Parameters>,
): void {
  for (const seed of SEEDS) {
    expect(simulateParameterized(rule, seed)).toEqual(
      simulateParameterized(rule, seed),
    );
  }
}

function expectActivePreMoveLabels<Parameters>(
  rule: DrawbackRule<ParameterizedRuleState, Parameters>,
): void {
  for (const seed of SEEDS) {
    const game = simulateParameterized(rule, seed);
    expect(game.plies.length).toBeGreaterThan(0);

    const initialByColor = new Map<string, unknown>();
    game.plies.forEach((ply, index) => {
      expect(ply.drawback.drawbackId).toBe(rule.id);
      expect(ply.drawback.state).toEqual({
        movesApplied: Math.floor(index / 2),
      });

      const knownParameters = initialByColor.get(ply.color);
      if (knownParameters === undefined) {
        initialByColor.set(ply.color, ply.drawback.parameters);
      } else {
        expect(ply.drawback.parameters).toEqual(knownParameters);
      }
    });
  }
}

describe("parameterized simulation properties", () => {
  it(
    "reproduces complete games for fixed parameter seeds",
    () => {
      expectFullGameDeterminism(untitledDuckDrawbackRule);
      expectFullGameDeterminism(justPassingThroughRule);
      expectFullGameDeterminism(gamblerRule);
    },
    CI_TIMEOUT_MS,
  );

  it(
    "labels each dataset row with the active pre-move parameters and state",
    () => {
      expectActivePreMoveLabels(untitledDuckDrawbackRule);
      expectActivePreMoveLabels(justPassingThroughRule);
      expectActivePreMoveLabels(gamblerRule);
    },
    CI_TIMEOUT_MS,
  );
});
