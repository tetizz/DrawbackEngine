import { describe, expect, it } from "vitest";
import type { ChessMove } from "@drawbackengine/drawback-engine";
import { Mulberry32, type RandomSource } from "@drawbackengine/shared";
import type { IterativeRootMoveScore } from "./iterative-search.js";
import { selectRootMoveByTemperature } from "./root-temperature-selector.js";

function move(from: string, to: string, san: string): ChessMove {
  return {
    from,
    to,
    color: "white",
    piece: "pawn",
    san,
    flags: "quiet",
  };
}

const SCORES: readonly IterativeRootMoveScore[] = [
  { move: move("a2", "a3", "a3"), score: 0, principalVariation: [] },
  { move: move("e2", "e4", "e4"), score: 80, principalVariation: [] },
  { move: move("d2", "d4", "d4"), score: 40, principalVariation: [] },
];

describe("selectRootMoveByTemperature", () => {
  it("is reproducible and returns a normalized scored distribution", () => {
    const first = selectRootMoveByTemperature(
      SCORES,
      new Mulberry32(99),
      { temperatureCp: 35 },
    );
    const second = selectRootMoveByTemperature(
      SCORES,
      new Mulberry32(99),
      { temperatureCp: 35 },
    );

    expect(second).toEqual(first);
    expect(first.distribution.reduce(
      (sum, candidate) => sum + candidate.probability,
      0,
    )).toBeCloseTo(1, 12);
    expect(SCORES.some((entry) =>
      entry.move.from === first.move.from
      && entry.move.to === first.move.to
    )).toBe(true);
  });

  it("supports deterministic top-k diversity", () => {
    const result = selectRootMoveByTemperature(
      SCORES,
      new Mulberry32(3),
      { temperatureCp: 10_000, topK: 2 },
    );

    expect(result.distribution).toHaveLength(2);
    expect(result.distribution.map((entry) => entry.move.san)).toEqual([
      "e4",
      "d4",
    ]);
  });

  it("uses one bounded RNG sample and validates adversarial input", () => {
    let calls = 0;
    const rng: RandomSource = {
      next() {
        calls += 1;
        return 0;
      },
      integer() {
        throw new Error("integer must not be used");
      },
    };
    expect(
      selectRootMoveByTemperature(
        SCORES,
        rng,
        { temperatureCp: 1 },
      ).move.san,
    ).toBe("e4");
    expect(calls).toBe(1);

    expect(() =>
      selectRootMoveByTemperature([], rng, { temperatureCp: 1 })
    ).toThrow("requires scored moves");
    expect(() =>
      selectRootMoveByTemperature(SCORES, rng, { temperatureCp: 0 })
    ).toThrow("greater than zero");
    expect(() =>
      selectRootMoveByTemperature(SCORES, rng, {
        temperatureCp: 1,
        topK: 4,
      })
    ).toThrow("available positive move count");
    const duplicate = SCORES.at(0);
    if (duplicate === undefined) {
      throw new Error("Expected a root score fixture.");
    }
    expect(() =>
      selectRootMoveByTemperature(
        [duplicate, duplicate],
        rng,
        { temperatureCp: 1 },
      )
    ).toThrow("Duplicate root move score");
  });

  it("rejects an invalid random source sample", () => {
    const rng: RandomSource = {
      next: () => 1,
      integer: () => 0,
    };
    expect(() =>
      selectRootMoveByTemperature(SCORES, rng, { temperatureCp: 20 })
    ).toThrow("value in [0, 1)");
  });
});
