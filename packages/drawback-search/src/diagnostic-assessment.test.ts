import { describe, expect, it, vi } from "vitest";
import {
  CapturableKingPosition,
  createPublicGameTrace,
  createStandardChessPositionSnapshot,
  publicAuthorityLegalMoves,
  type PublicPositionAuthoritySnapshot,
} from "@drawbackengine/chess-core";
import {
  unrestrictedRule,
  type ChessMove,
  type DrawbackRule,
  type PositionView,
} from "@drawbackengine/drawback-engine";
import { Mulberry32, type PlayerColor } from "@drawbackengine/shared";
import {
  assessPlayerPrivateDiagnosticMoves,
} from "./diagnostic-assessment.js";
import type {
  DiagnosticEvaluatorFailureError,
  StandardRepetitionAdjudicator,
} from "./diagnostic-assessment-types.js";
import {
  createOwnPlayerRuleCapability,
  createPublicDrawbackHypothesis,
} from "./player-private-capability.js";
import {
  UnsupportedDrawbackLeafPositionError,
  type DrawbackLeafEvaluator,
} from "./types.js";

const INITIAL_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const noRepetitionAdjudicator: StandardRepetitionAdjudicator = {
  id: "test-public-repetition/no-threefold",
  adjudicate: () => "not-threefold-repetition",
};

describe("assessPlayerPrivateDiagnosticMoves", () => {
  it("scores only replies permitted by surviving hypotheses and reports exact coverage", async () => {
    const position = CapturableKingPosition.fromFen().snapshot();
    const candidate = requiredMove(position, "e2", "e4");
    const onlyA6 = destinationRule("only-a6", ["a7a6"]);
    const onlyH6 = destinationRule("only-h6", ["h7h6"]);
    const masks: string[][] = [];
    const evaluator: DrawbackLeafEvaluator = {
      id: "mask-audit/v1",
      evaluate(leaf) {
        const mask = leaf.legalMoves.map(moveId).sort();
        masks.push(mask);
        return Promise.resolve(mask.includes("d7d5") ? 50_000 : 0);
      },
    };

    const result = await assessPlayerPrivateDiagnosticMoves({
      trace: createPublicGameTrace(position),
      own: ownCapability(position, "white", unrestrictedRule),
      opponent: [
        publicHypothesis(position, "a6-only", 0.75, "black", onlyA6),
        publicHypothesis(position, "h6-only", 0.25, "black", onlyH6),
      ],
      unsupportedOpponentAuthorities: [],
      candidateMoves: [candidate],
      evaluator,
    });

    expect(result.status).toBe("complete");
    if (result.status !== "complete") {
      throw new Error("Expected complete diagnostic assessment.");
    }
    expect(masks).toEqual([["a7a6"], ["h7h6"]]);
    expect(masks.flat()).not.toContain("d7d5");
    expect(result.moveAssessments[0]).toMatchObject({
      chessQuality: 0,
      worstCase: 0,
      risk: 0,
    });
    expect(result.coverage).toMatchObject({
      authorityId: "capturable-king/v1",
      candidateMoveCount: 1,
      assessedCandidateMoveCount: 1,
      requestedHypothesisCount: 2,
      supportedHypothesisCount: 2,
      unsupportedHypothesisCount: 0,
      supportedHypothesisProbabilityMass: 1,
      unsupportedHypothesisProbabilityMass: 0,
      exactReplyCoverage: true,
      exactAssessmentCoverage: true,
      evaluatorCalls: 2,
      unsupportedAuthorityFacts: [],
    });
    expect(
      result.recommendations.ranked[0]?.replyBranches.flatMap((branch) =>
        branch.reply.kind === "move" ? [moveId(branch.reply.move)] : []
      ),
    ).toEqual(expect.arrayContaining(["a7a6", "h7h6"]));
  });

  it("emits an immediate capturable-king terminal without consulting the evaluator", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    ).snapshot();
    const capture = requiredMove(position, "e7", "e8");
    const evaluate = vi.fn(() => Promise.resolve(0));

    const result = await assessPlayerPrivateDiagnosticMoves({
      trace: createPublicGameTrace(position),
      own: ownCapability(position, "white", unrestrictedRule),
      opponent: [
        publicHypothesis(
          position,
          "unrestricted-black",
          1,
          "black",
          unrestrictedRule,
        ),
      ],
      unsupportedOpponentAuthorities: [],
      candidateMoves: [capture],
      evaluator: { id: "must-not-run/v1", evaluate },
    });

    expect(result.status).toBe("complete");
    if (result.status !== "complete") {
      throw new Error("Expected complete diagnostic assessment.");
    }
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.moveAssessments[0]?.worstCase).toBe(999_999);
    const reply =
      result.recommendations.ranked[0]?.replyBranches[0]?.reply;
    expect(reply).toMatchObject({
      kind: "terminal",
      terminal: {
        kind: "king-capture",
        winner: "white",
        loser: "black",
        method: "direct",
      },
    });
  });

  it("treats an opponent king-capture reply as the exact worst case", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/8/8/8/8/8/4q3/4K2R w - - 0 1",
    ).snapshot();
    const candidate = requiredMove(position, "h1", "h2");
    const evaluator: DrawbackLeafEvaluator = {
      id: "neutral/v1",
      evaluate: () => Promise.resolve(0),
    };

    const result = await assessPlayerPrivateDiagnosticMoves({
      trace: createPublicGameTrace(position),
      own: ownCapability(position, "white", unrestrictedRule),
      opponent: [
        publicHypothesis(
          position,
          "unrestricted-black",
          1,
          "black",
          unrestrictedRule,
        ),
      ],
      unsupportedOpponentAuthorities: [],
      candidateMoves: [candidate],
      evaluator,
    });

    expect(result.status).toBe("complete");
    if (result.status !== "complete") {
      throw new Error("Expected complete diagnostic assessment.");
    }
    expect(result.moveAssessments[0]?.worstCase).toBe(-999_998);
    expect(
      result.recommendations.ranked[0]?.replyBranches.some(
        ({ reply }) =>
          reply.kind === "terminal"
          && reply.terminal.kind === "king-capture"
          && reply.reply?.from === "e2"
          && reply.reply.to === "e1",
      ),
    ).toBe(true);
  });

  it("requires standard repetition provenance and scores an injected threefold as a draw", async () => {
    const position = createStandardChessPositionSnapshot(INITIAL_FEN);
    const candidate = requiredMove(position, "e2", "e4");
    const evaluate = vi.fn(() => Promise.resolve(500));
    const base = {
      trace: createPublicGameTrace(position),
      own: ownCapability(position, "white", unrestrictedRule),
      opponent: [
        publicHypothesis(
          position,
          "unrestricted-black",
          1,
          "black",
          unrestrictedRule,
        ),
      ],
      unsupportedOpponentAuthorities: [],
      candidateMoves: [candidate],
      evaluator: { id: "unused-for-draw/v1", evaluate },
    };

    const missing = await assessPlayerPrivateDiagnosticMoves(base);
    expect(missing).toMatchObject({
      status: "unsupported",
      reason: "missing-standard-repetition-provenance",
      coverage: {
        exactReplyCoverage: false,
        exactAssessmentCoverage: false,
        standardRepetitionAdjudicatorId: null,
        evaluatorCalls: 0,
        unsupportedAuthorityFacts: [
          {
            component: "standard-repetition-adjudicator",
            authorityId: "standard-chess/v1",
          },
        ],
      },
    });

    const adjudicated = await assessPlayerPrivateDiagnosticMoves({
      ...base,
      standardRepetitionAdjudicator: {
        id: "test-public-repetition/threefold-after-root",
        adjudicate: ({ history }) =>
          history.length === 1
            ? "threefold-repetition"
            : "not-threefold-repetition",
      },
    });
    expect(adjudicated.status).toBe("complete");
    if (adjudicated.status !== "complete") {
      throw new Error("Expected complete repetition assessment.");
    }
    expect(adjudicated.moveAssessments[0]).toMatchObject({
      chessQuality: 0,
      worstCase: 0,
      risk: 0,
      hypotheses: [
        {
          source: "terminal",
          score: 0,
          permittedReplyCount: 0,
        },
      ],
    });
    expect(adjudicated.coverage).toMatchObject({
      exactReplyCoverage: true,
      exactAssessmentCoverage: true,
      standardRepetitionAdjudicatorId:
        "test-public-repetition/threefold-after-root",
      evaluatorCalls: 0,
    });
    expect(
      adjudicated.recommendations.ranked[0]?.replyBranches[0]?.reply,
    ).toMatchObject({
      kind: "terminal",
      terminal: {
        kind: "draw",
        reason: "threefold-repetition",
      },
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed on evaluator errors and reports unsupported evaluator coverage", async () => {
    const position = createStandardChessPositionSnapshot(INITIAL_FEN);
    const candidate = requiredMove(position, "e2", "e4");
    const failure = new Error("engine process exited");
    const failedEvaluator: DrawbackLeafEvaluator = {
      id: "failed-engine/v1",
      evaluate: () => Promise.reject(failure),
    };
    const input = {
      trace: createPublicGameTrace(position),
      own: ownCapability(position, "white", unrestrictedRule),
      opponent: [
        publicHypothesis(
          position,
          "unrestricted-black",
          1,
          "black",
          unrestrictedRule,
        ),
      ],
      unsupportedOpponentAuthorities: [],
      candidateMoves: [candidate],
      standardRepetitionAdjudicator: noRepetitionAdjudicator,
    };

    await expect(assessPlayerPrivateDiagnosticMoves({
      ...input,
      evaluator: failedEvaluator,
    })).rejects.toMatchObject({
      name: "DiagnosticEvaluatorFailureError",
      evaluatorId: "failed-engine/v1",
      candidateMoveId: "e2e4",
      hypothesisId: "unrestricted-black",
      cause: failure,
    } satisfies Partial<DiagnosticEvaluatorFailureError>);

    const unsupportedEvaluator: DrawbackLeafEvaluator = {
      id: "orthodox-only/v1",
      evaluate: () =>
        Promise.reject(
          new UnsupportedDrawbackLeafPositionError(
            "The exact public reply mask is not representable.",
          ),
        ),
    };
    const unsupported = await assessPlayerPrivateDiagnosticMoves({
      ...input,
      evaluator: unsupportedEvaluator,
    });
    expect(unsupported).toMatchObject({
      status: "unsupported",
      reason: "unsupported-leaf-evaluation",
      coverage: {
        exactReplyCoverage: true,
        exactAssessmentCoverage: false,
        assessedCandidateMoveCount: 0,
        evaluatorCalls: 1,
        unsupportedAuthorityFacts: [
          {
            component: "leaf-evaluator",
            authorityId: "standard-chess/v1",
            hypothesisId: "unrestricted-black",
            candidateMoveId: "e2e4",
            evaluatorId: "orthodox-only/v1",
          },
        ],
      },
    });
    if (unsupported.status === "unsupported") {
      expect(unsupported).not.toHaveProperty("recommendations");
    }
  });

  it("cancels an in-flight evaluator without producing partial recommendations", async () => {
    const position = createStandardChessPositionSnapshot(INITIAL_FEN);
    const candidate = requiredMove(position, "e2", "e4");
    const controller = new AbortController();
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const evaluator: DrawbackLeafEvaluator = {
      id: "cancel-aware/v1",
      evaluate(_leaf, signal) {
        announceStarted?.();
        return new Promise<number>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("cancelled", "AbortError"));
            },
            { once: true },
          );
        });
      },
    };

    const pending = assessPlayerPrivateDiagnosticMoves({
      trace: createPublicGameTrace(position),
      own: ownCapability(position, "white", unrestrictedRule),
      opponent: [
        publicHypothesis(
          position,
          "unrestricted-black",
          1,
          "black",
          unrestrictedRule,
        ),
      ],
      unsupportedOpponentAuthorities: [],
      candidateMoves: [candidate],
      evaluator,
      signal: controller.signal,
      standardRepetitionAdjudicator: noRepetitionAdjudicator,
    });
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("passes configurable weights through to diagnostic ranking", async () => {
    const position = CapturableKingPosition.fromFen().snapshot();
    const e4 = requiredMove(position, "e2", "e4");
    const d4 = requiredMove(position, "d2", "d4");
    const onlyA6 = destinationRule("only-a6", ["a7a6"]);
    const onlyH6 = destinationRule("only-h6", ["h7h6"]);
    const evaluator: DrawbackLeafEvaluator = {
      id: "weight-scenarios/v1",
      evaluate(leaf) {
        const rootMove = leaf.history[0];
        const reply = leaf.legalMoves[0];
        if (rootMove === undefined || reply === undefined) {
          return Promise.reject(new Error("Missing diagnostic history or mask."));
        }
        const rootScore =
          moveId(rootMove) === "e2e4"
            ? moveId(reply) === "a7a6" ? 100 : -100
            : 10;
        return Promise.resolve(-rootScore);
      },
    };
    const base = {
      trace: createPublicGameTrace(position),
      own: ownCapability(position, "white", unrestrictedRule),
      opponent: [
        publicHypothesis(position, "a6-only", 0.75, "black", onlyA6),
        publicHypothesis(position, "h6-only", 0.25, "black", onlyH6),
      ],
      unsupportedOpponentAuthorities: [],
      candidateMoves: [e4, d4],
      evaluator,
    };

    const expectedValue = await assessPlayerPrivateDiagnosticMoves({
      ...base,
      weights: {
        informationGain: 0,
        chessQuality: 1,
        worstCase: 0,
        risk: 0,
      },
    });
    const safety = await assessPlayerPrivateDiagnosticMoves({
      ...base,
      weights: {
        informationGain: 0,
        chessQuality: 0,
        worstCase: 1,
        risk: 1,
      },
    });

    expect(expectedValue.status).toBe("complete");
    expect(safety.status).toBe("complete");
    if (expectedValue.status !== "complete" || safety.status !== "complete") {
      throw new Error("Expected complete diagnostic assessments.");
    }
    expect(expectedValue.moveAssessments.map((entry) => ({
      move: moveId(entry.move),
      chessQuality: entry.chessQuality,
      worstCase: entry.worstCase,
      risk: entry.risk,
    }))).toEqual([
      {
        move: "e2e4",
        chessQuality: 50,
        worstCase: -100,
        risk: 37.5,
      },
      {
        move: "d2d4",
        chessQuality: 10,
        worstCase: 10,
        risk: 0,
      },
    ]);
    expect(
      moveId(expectedValue.recommendations.ranked[0]?.move ?? e4),
    ).toBe("e2e4");
    expect(
      moveId(safety.recommendations.ranked[0]?.move ?? e4),
    ).toBe("d2d4");
  });

  it("returns exact unsupported-hypothesis mass instead of a partial ranking", async () => {
    const position = createStandardChessPositionSnapshot(INITIAL_FEN);
    const candidate = requiredMove(position, "e2", "e4");
    const evaluate = vi.fn(() => Promise.resolve(0));

    const result = await assessPlayerPrivateDiagnosticMoves({
      trace: createPublicGameTrace(position),
      own: ownCapability(position, "white", unrestrictedRule),
      opponent: [
        publicHypothesis(
          position,
          "supported",
          0.75,
          "black",
          unrestrictedRule,
        ),
      ],
      unsupportedOpponentAuthorities: [
        {
          hypothesisId: "unsupported",
          drawbackId: "future-variant-rule",
          probability: 0.25,
          authorityId: "future-authority/v1",
          reason: "No exact public capability is installed.",
        },
      ],
      candidateMoves: [candidate],
      evaluator: { id: "unused/v1", evaluate },
      standardRepetitionAdjudicator: noRepetitionAdjudicator,
    });

    expect(result).toMatchObject({
      status: "unsupported",
      reason: "unsupported-opponent-authority",
      coverage: {
        candidateMoveCount: 1,
        assessedCandidateMoveCount: 0,
        requestedHypothesisCount: 2,
        supportedHypothesisCount: 1,
        unsupportedHypothesisCount: 1,
        supportedHypothesisProbabilityMass: 0.75,
        unsupportedHypothesisProbabilityMass: 0.25,
        exactReplyCoverage: false,
        exactAssessmentCoverage: false,
        evaluatorCalls: 0,
        unsupportedAuthorityFacts: [
          {
            component: "opponent-hypothesis",
            hypothesisId: "unsupported",
            drawbackId: "future-variant-rule",
            authorityId: "future-authority/v1",
            probability: 0.25,
          },
        ],
      },
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("recommendations");
  });
});

function destinationRule(
  id: string,
  allowedMoveIds: readonly string[],
): DrawbackRule<Record<string, never>, Record<string, never>> {
  return {
    id,
    name: id,
    description: "Test-only exact destination restriction.",
    verification: "verified",
    supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
    generateParameters: () => ({}),
    initialize: () => ({}),
    filterLegalMoves: (_context, moves) =>
      moves.filter((move) => allowedMoveIds.includes(moveId(move))),
    applyMove: () => ({}),
    checkStartOfTurnLoss: () => null,
  };
}

function ownCapability<State, Parameters>(
  position: PublicPositionAuthoritySnapshot,
  color: PlayerColor,
  rule: DrawbackRule<State, Parameters>,
  history: readonly ChessMove[] = [],
) {
  const parameters = rule.generateParameters(new Mulberry32(11));
  const view = positionView(position, history);
  return createOwnPlayerRuleCapability(
    position.authorityId,
    color,
    rule,
    parameters,
    rule.initialize({ color, parameters, position: view }),
    view,
  );
}

function publicHypothesis<State, Parameters>(
  position: PublicPositionAuthoritySnapshot,
  hypothesisId: string,
  probability: number,
  color: PlayerColor,
  rule: DrawbackRule<State, Parameters>,
) {
  const parameters = rule.generateParameters(new Mulberry32(13));
  return createPublicDrawbackHypothesis(
    hypothesisId,
    probability,
    color,
    rule,
    parameters,
    createPublicGameTrace(position),
  );
}

function positionView(
  position: PublicPositionAuthoritySnapshot,
  history: readonly ChessMove[],
): PositionView {
  const turn = position.fen.split(/\s+/u)[1];
  if (turn !== "w" && turn !== "b") {
    throw new Error("Invalid test FEN turn.");
  }
  return {
    fen: position.fen,
    turn: turn === "w" ? "white" : "black",
    ply: history.length,
    history,
  };
}

function requiredMove(
  position: PublicPositionAuthoritySnapshot,
  from: string,
  to: string,
): ChessMove {
  const move = publicAuthorityLegalMoves(position).find(
    (candidate) => candidate.from === from && candidate.to === to,
  );
  if (move === undefined) {
    throw new Error(`Missing test move ${from}${to}.`);
  }
  return move;
}

function moveId(
  move: Pick<ChessMove, "from" | "to" | "promotion">,
): string {
  return `${move.from}${move.to}${move.promotion?.[0] ?? ""}`;
}
