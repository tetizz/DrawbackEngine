import { describe, expect, it } from "vitest";
import { searchDiagnosticMoves } from "./index.js";
import type { ProbeHypothesis } from "./index.js";

interface TestState {
  readonly label: string;
}

const checkersHypothesis: ProbeHypothesis<TestState> = {
  drawbackId: "checkers",
  probability: 0.5,
  eliminated: false,
  state: { label: "capture-required" },
};
const veganHypothesis: ProbeHypothesis<TestState> = {
  drawbackId: "vegan",
  probability: 0.5,
  eliminated: false,
  state: { label: "no-knight-capture" },
};
const hypotheses: readonly ProbeHypothesis<TestState>[] = [
  checkersHypothesis,
  veganHypothesis,
];

describe("searchDiagnosticMoves", () => {
  it("finds a perfectly separating move and reports exact eliminations", () => {
    const result = searchDiagnosticMoves({
      moves: ["probe", "neutral"],
      hypotheses,
      permittedReplies: (move, hypothesis) =>
        move === "probe"
          ? [hypothesis.drawbackId === "checkers" ? "capture" : "quiet"]
          : ["shared"],
      replyKey: (reply) => reply,
      assessChess: () => ({ chessQuality: 0, worstCase: 0, risk: 0 }),
    });

    const probe = result.ranked.find(({ move }) => move === "probe");
    const neutral = result.ranked.find(({ move }) => move === "neutral");
    expect(probe?.currentEntropy).toBeCloseTo(Math.log(2));
    expect(probe?.expectedPosteriorEntropy).toBeCloseTo(0);
    expect(probe?.informationGain).toBeCloseTo(Math.log(2));
    expect(neutral?.informationGain).toBeCloseTo(0);
    expect(result.highestInformationMove.move).toBe("probe");
    expect(probe?.replyBranches).toEqual([
      {
        reply: "capture",
        probability: 0.5,
        posteriorEntropy: 0,
        survivingHypothesisIds: ["checkers"],
        eliminatedHypothesisIds: ["vegan"],
      },
      {
        reply: "quiet",
        probability: 0.5,
        posteriorEntropy: 0,
        survivingHypothesisIds: ["vegan"],
        eliminatedHypothesisIds: ["checkers"],
      },
    ]);
    expect(probe?.eliminations).toEqual([
      {
        drawbackId: "checkers",
        impossibleAfterReplies: ["quiet"],
        explanation:
          "checkers would be eliminated by each listed reply because that reply is impossible under the hypothesis.",
      },
      {
        drawbackId: "vegan",
        impossibleAfterReplies: ["capture"],
        explanation:
          "vegan would be eliminated by each listed reply because that reply is impossible under the hypothesis.",
      },
    ]);
  });

  it("computes expected entropy when reply sets overlap", () => {
    const result = searchDiagnosticMoves({
      moves: ["overlap"],
      hypotheses,
      permittedReplies: (_move, hypothesis) =>
        hypothesis.drawbackId === "checkers" ? ["capture", "shared"] : ["shared"],
      replyKey: (reply) => reply,
      assessChess: () => ({ chessQuality: 0, worstCase: 0, risk: 0 }),
    });

    const score = result.ranked[0];
    expect(score?.replyBranches.map(({ probability }) => probability)).toEqual([0.25, 0.75]);
    expect(score?.expectedPosteriorEntropy).toBeCloseTo(
      0.75 * (-(1 / 3) * Math.log(1 / 3) - (2 / 3) * Math.log(2 / 3)),
    );
    expect(score?.informationGain).toBeGreaterThan(0);
    expect(score?.informationGain).toBeLessThan(Math.log(2));
  });

  it("uses only callback assessments for the three recommendation modes", () => {
    const assessments = {
      strongest: { chessQuality: 10, worstCase: -8, risk: 9 },
      safest: { chessQuality: 2, worstCase: 4, risk: 0 },
      informative: { chessQuality: 1, worstCase: 0, risk: 0 },
    } as const;
    const result = searchDiagnosticMoves({
      moves: ["strongest", "safest", "informative"] as const,
      hypotheses,
      permittedReplies: (move, hypothesis) =>
        move === "informative"
          ? [hypothesis.drawbackId === "checkers" ? "capture" : "quiet"]
          : ["shared"],
      replyKey: (reply) => reply,
      assessChess: (move) => assessments[move],
      weights: { informationGain: 1, chessQuality: 0, worstCase: 1, risk: 1 },
    });

    expect(result.strongestChessMove.move).toBe("strongest");
    expect(result.safestDiagnosticMove.move).toBe("safest");
    expect(result.highestInformationMove.move).toBe("informative");
  });

  it("selects safety by worst case before information or blended score", () => {
    const result = searchDiagnosticMoves({
      moves: ["informative-risk", "safe-low-risk", "safe-high-risk"] as const,
      hypotheses,
      permittedReplies: (move, hypothesis) =>
        move === "informative-risk"
          ? [hypothesis.drawbackId === "checkers" ? "capture" : "quiet"]
          : ["shared"],
      replyKey: (reply) => reply,
      assessChess: (move) =>
        move === "informative-risk"
          ? { chessQuality: 10, worstCase: -2, risk: 0 }
          : move === "safe-high-risk"
            ? { chessQuality: 0, worstCase: 3, risk: 2 }
            : { chessQuality: 0, worstCase: 3, risk: 0 },
      weights: {
        informationGain: 100,
        chessQuality: 100,
        worstCase: 0,
        risk: 0,
      },
    });

    expect(result.ranked[0]?.move).toBe("informative-risk");
    expect(result.safestDiagnosticMove.move).toBe("safe-low-risk");
  });

  it("normalizes priors, ignores hard-eliminated hypotheses, and preserves stable ties", () => {
    const result = searchDiagnosticMoves({
      moves: ["first", "second"],
      hypotheses: [
        { ...checkersHypothesis, probability: 2 },
        { ...veganHypothesis, probability: 2 },
        {
          drawbackId: "already-impossible",
          probability: 1_000,
          eliminated: true,
          state: { label: "ignored" },
        },
      ],
      permittedReplies: () => ["shared"],
      replyKey: (reply) => reply,
      assessChess: () => ({ chessQuality: 1, worstCase: 1, risk: 1 }),
    });
    expect(result.ranked.map(({ move }) => move)).toEqual(["first", "second"]);
    expect(result.ranked[0]?.currentEntropy).toBeCloseTo(Math.log(2));
    expect(result.ranked[0]?.replyBranches[0]?.survivingHypothesisIds)
      .toEqual(["checkers", "vegan"]);
  });

  it("supports explicit non-uniform reply likelihoods", () => {
    const result = searchDiagnosticMoves({
      moves: ["probe"],
      hypotheses,
      permittedReplies: () => ["likely", "rare"],
      replyKey: (reply) => reply,
      replyLikelihood: (reply) => (reply === "likely" ? 0.9 : 0.1),
      assessChess: () => ({ chessQuality: 0, worstCase: 0, risk: 0 }),
    });
    expect(result.ranked[0]?.replyBranches.map(({ probability }) => probability))
      .toEqual([0.9, 0.1]);
    expect(result.ranked[0]?.informationGain).toBeCloseTo(0);
  });

  it("rejects invalid and underspecified inputs", () => {
    const base = {
      moves: ["probe"],
      hypotheses,
      permittedReplies: () => ["reply"],
      replyKey: (reply: string) => reply,
      assessChess: () => ({ chessQuality: 0, worstCase: 0, risk: 0 }),
    };
    expect(() => searchDiagnosticMoves({ ...base, moves: [] })).toThrow(
      "at least one candidate move",
    );
    expect(() => searchDiagnosticMoves({
      ...base,
      hypotheses: hypotheses.map((hypothesis) => ({ ...hypothesis, eliminated: true })),
    })).toThrow("at least one active hypothesis");
    expect(() => searchDiagnosticMoves({
      ...base,
      hypotheses: [{ ...checkersHypothesis, probability: -1 }],
    })).toThrow("cannot be negative");
    expect(() => searchDiagnosticMoves({
      ...base,
      permittedReplies: () => [],
    })).toThrow("represent terminal outcomes explicitly");
    expect(() => searchDiagnosticMoves({
      ...base,
      permittedReplies: () => ["duplicate", "duplicate"],
    })).toThrow("duplicate reply key");
  });
});
