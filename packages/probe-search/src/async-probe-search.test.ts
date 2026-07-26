import { describe, expect, it, vi } from "vitest";
import {
  searchDiagnosticMoves,
  searchDiagnosticMovesAsync,
} from "./index.js";
import type { ProbeHypothesis } from "./index.js";

interface TestState {
  readonly active: boolean;
}

const hypotheses: readonly ProbeHypothesis<TestState>[] = [
  {
    drawbackId: "checkers",
    probability: 0.65,
    eliminated: false,
    state: { active: true },
  },
  {
    drawbackId: "vegan",
    probability: 0.35,
    eliminated: false,
    state: { active: true },
  },
  {
    drawbackId: "eliminated",
    probability: 100,
    eliminated: true,
    state: { active: false },
  },
];

const assessments = {
  probe: { chessQuality: 1, worstCase: -0.5, risk: 0.25 },
  quiet: { chessQuality: 2, worstCase: 1, risk: 0.1 },
} as const;

function structuralOptions() {
  return {
    moves: ["probe", "quiet"] as const,
    hypotheses,
    permittedReplies: (
      move: "probe" | "quiet",
      hypothesis: ProbeHypothesis<TestState>,
    ) =>
      move === "probe"
        ? [
            hypothesis.drawbackId === "checkers" ? "capture" : "shared",
            "fallback",
          ]
        : ["shared"],
    replyKey: (reply: string) => reply,
    replyLikelihood: (reply: string) => (reply === "fallback" ? 0.2 : 0.8),
    weights: {
      informationGain: 1.2,
      chessQuality: 0.4,
      worstCase: 0.6,
      risk: 0.8,
    },
  };
}

describe("searchDiagnosticMovesAsync", () => {
  it("is deeply equivalent to sync search when assessments are equivalent", async () => {
    const sync = searchDiagnosticMoves({
      ...structuralOptions(),
      assessChess: (move) => assessments[move],
    });
    const calls: string[] = [];
    const asynchronous = await searchDiagnosticMovesAsync({
      ...structuralOptions(),
      assessChess: async (move) => {
        await Promise.resolve();
        calls.push(move);
        return assessments[move];
      },
    });

    expect(asynchronous).toEqual(sync);
    expect(calls).toEqual(["probe", "quiet"]);
  });

  it("preserves stable input-order ties with immediately resolved assessments", async () => {
    const result = await searchDiagnosticMovesAsync({
      moves: ["first", "second"],
      hypotheses: hypotheses.slice(0, 2),
      permittedReplies: () => ["shared"],
      replyKey: (reply) => reply,
      assessChess: (move) =>
        Promise.resolve({
          chessQuality: move.length - move.length,
          worstCase: 0,
          risk: 0,
        }),
    });
    expect(result.ranked.map(({ move }) => move)).toEqual(["first", "second"]);
    expect(result.strongestChessMove.move).toBe("first");
    expect(result.safestDiagnosticMove.move).toBe("first");
    expect(result.highestInformationMove.move).toBe("first");
  });

  it("propagates an evaluator rejection without evaluating later moves", async () => {
    const failure = new Error("engine process exited");
    const assessChess = vi.fn((move: "probe" | "quiet") =>
      move === "probe" ? Promise.reject(failure) : Promise.resolve(assessments[move]),
    );
    await expect(searchDiagnosticMovesAsync({
      ...structuralOptions(),
      assessChess,
    })).rejects.toBe(failure);
    expect(assessChess).toHaveBeenCalledTimes(1);
    expect(assessChess).toHaveBeenCalledWith("probe");
  });

  it("retains structural validation before invoking the assessment", async () => {
    const assessChess = vi.fn(() => Promise.resolve(assessments.probe));
    await expect(searchDiagnosticMovesAsync({
      moves: ["probe"],
      hypotheses: hypotheses.slice(0, 2),
      permittedReplies: () => ["duplicate", "duplicate"],
      replyKey: (reply) => reply,
      assessChess,
    })).rejects.toThrow("duplicate reply key");
    expect(assessChess).not.toHaveBeenCalled();

    await expect(searchDiagnosticMovesAsync({
      moves: [],
      hypotheses: hypotheses.slice(0, 2),
      permittedReplies: () => ["reply"],
      replyKey: (reply: string) => reply,
      assessChess,
    })).rejects.toThrow("at least one candidate move");
    expect(assessChess).not.toHaveBeenCalled();
  });

  it("applies the same finite assessment validation as sync search", async () => {
    const options = {
      moves: ["probe"],
      hypotheses: hypotheses.slice(0, 2),
      permittedReplies: () => ["reply"],
      replyKey: (reply: string) => reply,
    };
    expect(() => searchDiagnosticMoves({
      ...options,
      assessChess: () => ({
        chessQuality: Number.NaN,
        worstCase: 0,
        risk: 0,
      }),
    })).toThrow("chessQuality must be finite");
    await expect(searchDiagnosticMovesAsync({
      ...options,
      assessChess: () =>
        Promise.resolve({
          chessQuality: Number.NaN,
          worstCase: 0,
          risk: 0,
        }),
    })).rejects.toThrow("chessQuality must be finite");
  });

  it("honors cancellation before and between asynchronous assessments", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const neverCalled = vi.fn(() => Promise.resolve(assessments.probe));
    await expect(searchDiagnosticMovesAsync({
      ...structuralOptions(),
      assessChess: neverCalled,
      signal: preAborted.signal,
    })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(neverCalled).not.toHaveBeenCalled();

    const betweenMoves = new AbortController();
    const assessed: string[] = [];
    await expect(searchDiagnosticMovesAsync({
      ...structuralOptions(),
      assessChess: (move) => {
        assessed.push(move);
        betweenMoves.abort();
        return assessments[move];
      },
      signal: betweenMoves.signal,
    })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(assessed).toEqual(["probe"]);
  });
});
