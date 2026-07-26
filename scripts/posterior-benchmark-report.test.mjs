import { describe, expect, it } from "vitest";
import {
  combinePosteriorBenchmarkReports,
  createPosteriorBenchmarkReport,
  parsePosteriorBenchmarkReport,
} from "./posterior-benchmark-report.mjs";

const inputPath = "C:\\private\\validation.ndjson";
const expected = {
  inputPath,
  startGameIndex: 0,
  count: 2,
  targetPly: 8,
  depth: 2,
  maxNodes: 10_000,
};

describe("posterior benchmark reports", () => {
  it("combines a complete ordered shard union and recomputes metrics", () => {
    const first = report(0, [
      comparison(0, {
        posteriorCvar25Move: "b2b3",
        posteriorCvar25OracleScore: 100,
      }),
    ]);
    const second = report(1, [
      comparison(1, {
        posteriorExpectedMove: "c2c3",
        posteriorExpectedOracleScore: -40,
      }),
    ]);

    const combined = combinePosteriorBenchmarkReports(
      [second, first],
      expected,
    );

    expect(combined.comparisons.map(({ gameIndex }) => gameIndex))
      .toEqual([0, 1]);
    expect(combined.posteriorCvar25).toEqual({
      differingMoves: 1,
      candidateOracleWins: 1,
      worstCaseOracleWins: 0,
      equalOracleScoresOnDifferingMoves: 0,
      meanCandidateMinusWorstCaseOracleCp: 50,
    });
    expect(combined.posteriorExpected).toMatchObject({
      differingMoves: 1,
      candidateOracleWins: 0,
      worstCaseOracleWins: 1,
      meanCandidateMinusWorstCaseOracleCp: -20,
    });
  });

  it("rejects a duplicate or missing game index", () => {
    const first = report(0, [comparison(0)]);
    expect(() =>
      combinePosteriorBenchmarkReports([first, first], expected)
    ).toThrow("exactly once");

    const third = report(2, [comparison(2)]);
    expect(() =>
      combinePosteriorBenchmarkReports([first, third], expected)
    ).toThrow("exactly once");
  });

  it("rejects mismatched shard parameters", () => {
    const first = report(0, [comparison(0)]);
    const second = createPosteriorBenchmarkReport({
      ...expected,
      startGameIndex: 1,
      count: 1,
      depth: 3,
      comparisons: [comparison(1)],
    });

    expect(() =>
      combinePosteriorBenchmarkReports([first, second], expected)
    ).toThrow("parameters do not match");
  });

  it("rejects an unordered declared range or wrong target ply", () => {
    expect(() =>
      createPosteriorBenchmarkReport({
        ...expected,
        comparisons: [comparison(1), comparison(0)],
      })
    ).toThrow("ordered");
    expect(() =>
      createPosteriorBenchmarkReport({
        ...expected,
        count: 1,
        comparisons: [comparison(0, { ply: 7 })],
      })
    ).toThrow("target ply");
  });

  it("rejects a tampered derived summary", () => {
    const valid = report(0, [comparison(0)]);
    const tampered = {
      ...valid,
      posteriorCvar25: {
        ...valid.posteriorCvar25,
        differingMoves: 1,
      },
    };

    expect(() => parsePosteriorBenchmarkReport(tampered))
      .toThrow("summary is inconsistent");
  });

  it("rejects unknown fields, invalid moves, and non-finite scores", () => {
    const valid = report(0, [comparison(0)]);
    expect(() =>
      parsePosteriorBenchmarkReport({ ...valid, secret: "hidden" })
    ).toThrow("invalid fields");
    expect(() =>
      createPosteriorBenchmarkReport({
        ...expected,
        count: 1,
        comparisons: [comparison(0, { worstCaseMove: "not-a-move" })],
      })
    ).toThrow("coordinate move ID");
    expect(() =>
      createPosteriorBenchmarkReport({
        ...expected,
        count: 1,
        comparisons: [
          comparison(0, { posteriorCvar25OracleScore: Number.NaN }),
        ],
      })
    ).toThrow("must be finite");
  });

  it("excludes truncated positions from candidate summaries", () => {
    const result = createPosteriorBenchmarkReport({
      ...expected,
      comparisons: [
        comparison(0, {
          posteriorCvar25Move: "b2b3",
          posteriorCvar25OracleScore: 100,
          truncated: true,
        }),
        comparison(1),
      ],
    });

    expect(result.completePositions).toBe(1);
    expect(result.truncatedPositions).toBe(1);
    expect(result.posteriorCvar25.differingMoves).toBe(0);
  });
});

function report(startGameIndex, comparisons) {
  return createPosteriorBenchmarkReport({
    ...expected,
    startGameIndex,
    count: comparisons.length,
    comparisons,
  });
}

function comparison(gameIndex, overrides = {}) {
  return {
    gameIndex,
    ply: 8,
    color: "white",
    hypothesisCount: 25,
    worstCaseMove: "a2a3",
    posteriorExpectedMove: "a2a3",
    posteriorCvar25Move: "a2a3",
    worstCaseSearchScore: 0,
    posteriorExpectedSearchScore: 0,
    posteriorCvar25SearchScore: 0,
    worstCaseOracleScore: 0,
    posteriorExpectedOracleScore: 0,
    posteriorCvar25OracleScore: 0,
    truncated: false,
    ...overrides,
  };
}
