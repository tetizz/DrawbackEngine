import { describe, expect, it } from "vitest";
import { deriveGameSeed, simulateCatalogBatch } from "./batch.js";
import {
  CATALOG_AGENT_IDS,
  EXECUTABLE_RULE_IDS,
  deriveCatalogGameSpec,
  type ExecutableRuleId,
} from "./catalog.js";

const CI_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

describe("catalog-driven simulation", () => {
  it("contains all 180 executable rules and every implemented agent profile", () => {
    expect(EXECUTABLE_RULE_IDS).toHaveLength(180);
    expect(EXECUTABLE_RULE_IDS).toEqual(
      expect.arrayContaining([
        "untitled-duck-drawback",
        "just-passing-through",
        "gambler",
        "number-of-the-beast",
        "shadow-queen",
        "entrenched",
        "no-shuffling",
        "stop-stalling",
        "greedy",
        "queen-bee",
        "alternator",
        "hopscotch",
        "colorblind",
        "hand-and-brainless",
        "obsession",
        "winds-of-fate",
        "expedition",
        "reflective",
        "eye-of-sauron",
        "drag",
        "ooh-shiny",
        "bridge-over-troubled-water",
        "reconnaissance",
      ]),
    );
    expect(CATALOG_AGENT_IDS).toHaveLength(5);
  });

  it("derives independent White and Black rule, style, and strength selections", () => {
    const selections = Array.from({ length: 12 }, (_, gameIndex) =>
      deriveCatalogGameSpec(deriveGameSeed(0x51ec7, gameIndex)),
    );
    expect(selections).toEqual(
      Array.from({ length: 12 }, (_, gameIndex) =>
        deriveCatalogGameSpec(deriveGameSeed(0x51ec7, gameIndex)),
      ),
    );
    expect(
      selections.some(
        (selection) => selection.whiteRuleId !== selection.blackRuleId,
      ),
    ).toBe(true);
    expect(
      selections.some(
        (selection) => selection.whiteAgent.id !== selection.blackAgent.id,
      ),
    ).toBe(true);
    for (const selection of selections) {
      expect(selection.whiteAgent.strength).toBeGreaterThan(0);
      expect(selection.blackAgent.strength).toBeGreaterThan(0);
      expect(["random", "material", "human-like"]).toContain(
        selection.whiteAgent.style,
      );
      expect(["random", "material", "human-like"]).toContain(
        selection.blackAgent.style,
      );
    }
  });

  it(
    "reproduces complete randomized games for a fixed batch seed",
    () => {
      const request = {
        seed: 9001,
        games: 8,
        maxPlies: 12,
      } as const;
      expect(simulateCatalogBatch(request)).toEqual(
        simulateCatalogBatch(request),
      );
    },
    CI_TIMEOUT_MS,
  );

  it(
    "emits non-empty active hidden parameters for every parameterized rule",
    () => {
      const parameterizedRules: readonly ExecutableRuleId[] = [
        "untitled-duck-drawback",
        "just-passing-through",
        "gambler",
        "crenellations",
        "theocracy",
        "active-volcano",
        "comfort-zone",
        "blinded-by-the-sun",
        "colorblind",
        "hand-and-brainless",
        "obsession",
        "winds-of-fate",
      ];
      parameterizedRules.forEach((ruleId, index) => {
        const games = simulateCatalogBatch({
          seed: 700 + index,
          games: ruleId === "hand-and-brainless" ? 12 : 2,
          maxPlies: 6,
          ruleIds: [ruleId],
          agentIds: ["random-legal"],
        });
        const plies = games.flatMap((game) => game.plies);
        expect(plies.length, ruleId).toBeGreaterThan(0);
        for (const ply of plies) {
          expect(ply.drawback.drawbackId).toBe(ruleId);
          expect(isRecord(ply.drawback.parameters)).toBe(true);
          if (isRecord(ply.drawback.parameters)) {
            expect(Object.keys(ply.drawback.parameters).length).toBeGreaterThan(0);
          }
          expect(isRecord(ply.drawback.state)).toBe(true);
          if (isRecord(ply.drawback.state)) {
            expect(typeof ply.drawback.state["movesApplied"]).toBe(
              "number",
            );
          }
        }
      });
    },
    CI_TIMEOUT_MS,
  );

  it("rejects empty selection catalogs", () => {
    expect(() => deriveCatalogGameSpec(1, { ruleIds: [] })).toThrow(RangeError);
    expect(() => deriveCatalogGameSpec(1, { agentIds: [] })).toThrow(RangeError);
  });
});
