import { describe, expect, it } from "vitest";
import {
  drawbackMaterialEvaluator,
  type DrawbackLeafEvaluator,
  type LeafPosition,
} from "@drawbackengine/drawback-search";
import {
  runPlayerPrivateStrengthHarness,
  summarizePairedStrengthScores,
  unrestrictedOpponentHypotheses,
  type PlayerPrivateGameAssignment,
  type PlayerPrivateStrengthParticipant,
} from "./index.js";

const immediateCaptureAssignment = Object.freeze({
  seed: 0x51a7_e101,
  parameterSeeds: Object.freeze({
    white: 0x51a7_e102,
    black: 0x51a7_e103,
  }),
  whiteRuleId: "vegan",
  blackRuleId: "checkers",
  initialFen: "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
} as const satisfies PlayerPrivateGameAssignment);

function participant(
  id: string,
  evaluator: DrawbackLeafEvaluator = drawbackMaterialEvaluator,
): PlayerPrivateStrengthParticipant {
  return Object.freeze({
    id,
    evaluatorKind: "material",
    evaluator,
    limits: Object.freeze({
      maxDepth: 1,
      maxNodes: 5_000,
      leafCacheHistoryMode: "full" as const,
    }),
    opponentAggregation: "worst-case",
    temperature: Object.freeze({ temperatureCp: 1, topK: 1 }),
  });
}

describe("paired player-private strength statistics", () => {
  it("keeps ply-limit games censored and reports exact score bounds", () => {
    const summary = summarizePairedStrengthScores([
      { candidateWhite: 1, candidateBlack: 0 },
      { candidateWhite: 1, candidateBlack: 1 },
      { candidateWhite: 0.5, candidateBlack: null },
    ]);

    expect(summary.candidate).toMatchObject({
      wins: 3,
      draws: 1,
      losses: 1,
      completedGames: 5,
      plyLimitGames: 1,
      completedGameScore: 0.7,
    });
    expect(summary.baseline).toMatchObject({
      wins: 1,
      draws: 1,
      losses: 3,
      completedGames: 5,
      plyLimitGames: 1,
      completedGameScore: 0.3,
    });
    expect(summary.decisiveGames).toBe(4);
    expect(summary.drawnGames).toBe(1);
    expect(summary.plyLimitGames).toBe(1);
    expect(summary.completedPairs).toBe(2);
    expect(summary.plyLimitPairs).toBe(1);
    expect(summary.completedPairMeanDelta).toBe(0.25);
    expect(summary.scheduledPairMeanDelta).toBeNull();
    expect(summary.candidate.scheduledGameScoreBounds.lower).toBeCloseTo(
      3.5 / 6,
      12,
    );
    expect(summary.candidate.scheduledGameScoreBounds.upper).toBeCloseTo(
      4.5 / 6,
      12,
    );
    expect(summary.scheduledPairMeanDeltaBounds.lower).toBeCloseTo(
      1 / 12,
      12,
    );
    expect(summary.scheduledPairMeanDeltaBounds.upper).toBeCloseTo(
      0.25,
      12,
    );
    expect(summary.pairedDeltaUncertainty).toMatchObject({
      confidenceLevel: 0.95,
      method: "hoeffding-bounded-pairs-with-censoring",
      pairCount: 3,
    });
    expect(summary.pairedDeltaUncertainty.lower).toBeLessThanOrEqual(
      summary.scheduledPairMeanDeltaBounds.lower,
    );
    expect(summary.pairedDeltaUncertainty.upper).toBeGreaterThanOrEqual(
      summary.scheduledPairMeanDeltaBounds.upper,
    );
  });

  it("rejects empty samples, invalid scores, and invalid confidence levels", () => {
    expect(() => summarizePairedStrengthScores([])).toThrow(
      "at least one game pair",
    );
    expect(() => summarizePairedStrengthScores([
      { candidateWhite: 0.25 as 0, candidateBlack: 1 },
    ])).toThrow("0, 0.5, 1, or null");
    expect(() => summarizePairedStrengthScores([
      { candidateWhite: 1, candidateBlack: 0 },
    ], 1)).toThrow("between zero and one");
  });
});

describe("player-private strength harness", () => {
  it("replays identical hidden assignments with candidate colors swapped", async () => {
    const observedLeafKeys: string[][] = [];
    const inspectingEvaluator: DrawbackLeafEvaluator = Object.freeze({
      id: drawbackMaterialEvaluator.id,
      async evaluate(position: LeafPosition, signal?: AbortSignal) {
        observedLeafKeys.push(Object.keys(position).sort());
        return drawbackMaterialEvaluator.evaluate(position, signal);
      },
    });
    const options = {
      candidate: participant("candidate-depth-one", inspectingEvaluator),
      baseline: participant("baseline-depth-one"),
      assignments: [immediateCaptureAssignment],
      opponentHypotheses: unrestrictedOpponentHypotheses,
      maxPlies: 1,
    } as const;

    const first = await runPlayerPrivateStrengthHarness(options);
    const second = await runPlayerPrivateStrengthHarness(options);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      format: "drawbackengine-player-private-strength/v1",
      knowledgeMode: "player-private",
      metric: "paired-game-score",
      pairing: "same-hidden-assignment-and-seeds-with-candidate-color-swap",
      hypothesisPolicyId: "unrestricted-baseline/v1",
      maxPlies: 1,
    });
    expect(first.participants.candidate).toMatchObject({
      role: "candidate",
      id: "candidate-depth-one",
      evaluator: {
        kind: "material",
        id: "drawback-material/v1",
      },
    });
    expect(first.participants.baseline.role).toBe("baseline");
    expect(first.pairs).toHaveLength(1);
    expect(first.pairs[0]).toMatchObject({
      executionOrder: ["white", "black"],
      pairedCandidateScore: 0.5,
      pairedScoreDelta: 0,
      candidateWhite: {
        candidateColor: "white",
        outcome: "king-capture",
        winner: "white",
        candidateScore: 1,
      },
      candidateBlack: {
        candidateColor: "black",
        outcome: "king-capture",
        winner: "white",
        candidateScore: 0,
      },
    });
    expect(first.summary.candidate).toMatchObject({
      wins: 1,
      draws: 0,
      losses: 1,
      completedGameScore: 0.5,
    });
    expect(first.summary.decisiveGames).toBe(2);
    expect(first.summary.plyLimitGames).toBe(0);
    expect(first.summary.scheduledPairMeanDelta).toBe(0);
    expect(first).not.toHaveProperty("assignmentsSha256");
    expect(first.pairs[0]).not.toHaveProperty("hiddenAssignmentSha256");
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("whiteRuleId");
    expect(serialized).not.toContain("blackRuleId");
    expect(serialized).not.toContain("parameterSeeds");
    expect(serialized).not.toContain('"vegan"');
    expect(serialized).not.toContain('"checkers"');
    expect(observedLeafKeys.length).toBeGreaterThan(0);
    for (const keys of observedLeafKeys) {
      expect(keys).toEqual([
        "authorityId",
        "fen",
        "history",
        "kingPassantActive",
        "legalMoves",
        "orthodoxCompatible",
        "turn",
      ]);
    }
  });

  it("rejects duplicate seeds and mislabeled evaluators before play", async () => {
    await expect(runPlayerPrivateStrengthHarness({
      candidate: participant("candidate"),
      baseline: participant("baseline"),
      assignments: [
        immediateCaptureAssignment,
        { ...immediateCaptureAssignment },
      ],
      maxPlies: 1,
    })).rejects.toThrow("seeds must be unique");

    await expect(runPlayerPrivateStrengthHarness({
      candidate: {
        ...participant("candidate"),
        evaluatorKind: "fairy-stockfish",
      },
      baseline: participant("baseline"),
      assignments: [immediateCaptureAssignment],
      maxPlies: 1,
    })).rejects.toThrow("pinned node-uci-leaf/v1 evaluator ID");

    await expect(runPlayerPrivateStrengthHarness({
      candidate: {
        ...participant("candidate"),
        evaluatorKind: "unknown" as "material",
      },
      baseline: participant("baseline"),
      assignments: [immediateCaptureAssignment],
      maxPlies: 1,
    })).rejects.toThrow("kind must be material or fairy-stockfish");
  });

  it("alternates pair execution order and honors pre-aborted work", async () => {
    const secondAssignment = Object.freeze({
      ...immediateCaptureAssignment,
      seed: 0x51a7_e201,
      parameterSeeds: Object.freeze({
        white: 0x51a7_e202,
        black: 0x51a7_e203,
      }),
    });
    const report = await runPlayerPrivateStrengthHarness({
      candidate: participant("candidate"),
      baseline: participant("baseline"),
      assignments: [immediateCaptureAssignment, secondAssignment],
      opponentHypotheses: unrestrictedOpponentHypotheses,
      maxPlies: 1,
    });
    expect(report.pairs.map(({ executionOrder }) => executionOrder)).toEqual([
      ["white", "black"],
      ["black", "white"],
    ]);

    const controller = new AbortController();
    const reason = new Error("strength benchmark cancelled");
    controller.abort(reason);
    await expect(runPlayerPrivateStrengthHarness({
      candidate: participant("candidate"),
      baseline: participant("baseline"),
      assignments: [immediateCaptureAssignment],
      signal: controller.signal,
    })).rejects.toBe(reason);
  });
});
