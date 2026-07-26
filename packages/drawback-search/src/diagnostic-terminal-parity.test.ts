import { describe, expect, it, vi } from "vitest";
import {
  CapturableKingPosition,
  DrawbackGameSession,
  GameSession,
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
import { assessPlayerPrivateDiagnosticMoves } from "./diagnostic-assessment.js";
import type {
  StandardRepetitionAdjudicator,
} from "./diagnostic-assessment-types.js";
import {
  createOwnPlayerRuleCapability,
  createPublicDrawbackHypothesis,
} from "./player-private-capability.js";

const INITIAL_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const noRepetitionAdjudicator: StandardRepetitionAdjudicator = {
  id: "test-public-repetition/no-threefold",
  adjudicate: () => "not-threefold-repetition",
};

describe("diagnostic terminal parity", () => {
  it.each([
    {
      authorityId: "standard-chess/v1" as const,
      position: createStandardChessPositionSnapshot(INITIAL_FEN),
    },
    {
      authorityId: "capturable-king/v1" as const,
      position: CapturableKingPosition.fromFen(INITIAL_FEN).snapshot(),
    },
  ])(
    "matches $authorityId when the root drawback filters every move after a reply",
    async ({ authorityId, position }) => {
      const ownRule = allowUntilPlyRule("root-empty-after-reply", 2);
      const evaluate = vi.fn(() => Promise.resolve(321));
      const result = await assessPlayerPrivateDiagnosticMoves({
        trace: createPublicGameTrace(position),
        own: ownCapability(position, "white", ownRule),
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
        candidateMoves: [requiredMove(position, "e2", "e4")],
        evaluator: { id: "must-not-run/root-loss", evaluate },
        ...(authorityId === "standard-chess/v1"
          ? { standardRepetitionAdjudicator: noRepetitionAdjudicator }
          : {}),
      });

      expect(result.status).toBe("complete");
      if (result.status !== "complete") {
        throw new Error("Expected a complete root-loss assessment.");
      }
      expect(evaluate).not.toHaveBeenCalled();
      expect(result.moveAssessments[0]).toMatchObject({
        chessQuality: -999_998,
        worstCase: -999_998,
        risk: 0,
        hypotheses: [
          {
            source: "terminal",
            score: -999_998,
          },
        ],
      });
      expect(
        result.recommendations.ranked[0]?.replyBranches.every(
          ({ reply }) =>
            reply.kind === "terminal"
            && reply.reply !== undefined
            && reply.terminal.kind === "drawback-loss"
            && reply.terminal.loser === "white"
            && reply.terminal.drawbackId === ownRule.id,
        ),
      ).toBe(true);

      const session =
        authorityId === "standard-chess/v1"
          ? new GameSession(
              { white: ownRule, black: unrestrictedRule },
              new Mulberry32(17),
              INITIAL_FEN,
            )
          : DrawbackGameSession.create(
              { white: ownRule, black: unrestrictedRule },
              new Mulberry32(17),
              INITIAL_FEN,
            );
      expect(session.move({ from: "e2", to: "e4" })).toMatchObject({
        ok: true,
        result: { kind: "active" },
      });
      expect(session.move({ from: "e7", to: "e5" })).toMatchObject({
        ok: true,
        result: {
          kind: "drawback-loss",
          loss: {
            ruleId: ownRule.id,
            color: "white",
          },
        },
      });
    },
  );

  it.each([
    {
      name: "insufficient material",
      fen: "k7/8/8/8/8/2n5/1B6/K7 w - - 0 1",
      from: "b2",
      to: "c3",
      drawReason: "insufficient-material" as const,
    },
    {
      name: "fifty-move",
      fen: "7k/8/8/8/8/8/1R6/K7 w - - 99 1",
      from: "b2",
      to: "a2",
      drawReason: "fifty-move" as const,
    },
  ])(
    "gives a nonempty opponent drawback filter-to-zero precedence over $name",
    async ({ fen, from, to, drawReason }) => {
      const position = createStandardChessPositionSnapshot(fen);
      const noRepliesRule = allowOnlyMovesRule("opponent-no-replies", []);
      const evaluate = vi.fn(() => Promise.resolve(999));
      const base = {
        trace: createPublicGameTrace(position),
        own: ownCapability(position, "white", unrestrictedRule),
        unsupportedOpponentAuthorities: [] as const,
        candidateMoves: [requiredMove(position, from, to)],
        evaluator: { id: "must-not-run/opponent-loss", evaluate },
        standardRepetitionAdjudicator: noRepetitionAdjudicator,
      };
      const filtered = await assessPlayerPrivateDiagnosticMoves({
        ...base,
        opponent: [
          publicHypothesis(
            position,
            "no-replies-black",
            1,
            "black",
            noRepliesRule,
          ),
        ],
      });

      expect(filtered.status).toBe("complete");
      if (filtered.status !== "complete") {
        throw new Error("Expected a complete opponent-loss assessment.");
      }
      expect(filtered.moveAssessments[0]?.worstCase).toBe(999_999);
      expect(
        filtered.recommendations.ranked[0]?.replyBranches[0]?.reply,
      ).toMatchObject({
        kind: "terminal",
        terminal: {
          kind: "no-drawback-legal-replies",
          winner: "white",
          loser: "black",
          drawbackId: noRepliesRule.id,
        },
      });
      expect(evaluate).not.toHaveBeenCalled();

      const session = new GameSession(
        { white: unrestrictedRule, black: noRepliesRule },
        new Mulberry32(23),
        fen,
      );
      expect(session.move({ from, to })).toMatchObject({
        ok: true,
        result: {
          kind: "drawback-loss",
          loss: {
            ruleId: noRepliesRule.id,
            color: "black",
          },
        },
      });

      const drawn = await assessPlayerPrivateDiagnosticMoves({
        ...base,
        opponent: [
          publicHypothesis(
            position,
            "unrestricted-black",
            1,
            "black",
            unrestrictedRule,
          ),
        ],
      });
      expect(drawn.status).toBe("complete");
      if (drawn.status !== "complete") {
        throw new Error("Expected a complete standard draw assessment.");
      }
      expect(drawn.moveAssessments[0]?.worstCase).toBe(0);
      expect(
        drawn.recommendations.ranked[0]?.replyBranches[0]?.reply,
      ).toMatchObject({
        kind: "terminal",
        terminal: {
          kind: "draw",
          reason: drawReason,
        },
      });
    },
  );

  it.each([
    {
      name: "checkmate",
      from: "f7",
      to: "f8",
      terminal: {
        kind: "checkmate",
        winner: "white",
        loser: "black",
      },
      score: 999_999,
    },
    {
      name: "stalemate",
      from: "f7",
      to: "e6",
      terminal: {
        kind: "draw",
        winner: null,
        reason: "stalemate",
      },
      score: 0,
    },
  ])(
    "gives $name precedence over a claimed repetition when authority replies are empty",
    async ({ from, to, terminal, score }) => {
      const position = createStandardChessPositionSnapshot(
        "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1",
      );
      const adjudicate = vi.fn(
        ({ history }: { readonly history: readonly ChessMove[] }) =>
          history.length === 0
            ? "not-threefold-repetition" as const
            : "threefold-repetition" as const,
      );
      const evaluate = vi.fn(() => Promise.resolve(777));
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
        candidateMoves: [requiredMove(position, from, to)],
        evaluator: { id: "must-not-run/authority-terminal", evaluate },
        standardRepetitionAdjudicator: {
          id: "test-public-repetition/claimed-after-root",
          adjudicate,
        },
      });

      expect(result.status).toBe("complete");
      if (result.status !== "complete") {
        throw new Error("Expected a complete authority terminal assessment.");
      }
      expect(result.moveAssessments[0]?.worstCase).toBe(score);
      expect(
        result.recommendations.ranked[0]?.replyBranches[0]?.reply,
      ).toMatchObject({
        kind: "terminal",
        terminal,
      });
      expect(adjudicate).toHaveBeenCalledTimes(1);
      expect(evaluate).not.toHaveBeenCalled();
    },
  );

  it("uses one hypothesis-independent capturable no-legal-moves branch", async () => {
    const fen =
      "kp6/pp4K1/pp6/pp6/pp6/pp6/pp6/pp6 w - - 0 1";
    const position = CapturableKingPosition.fromFen(fen).snapshot();
    const candidate = requiredMove(position, "g7", "h8");
    const adjudicate = vi.fn(() => {
      throw new Error("Capturable authority must not ask about repetition.");
    });
    const evaluate = vi.fn(() => Promise.resolve(888));
    const result = await assessPlayerPrivateDiagnosticMoves({
      trace: createPublicGameTrace(position),
      own: ownCapability(position, "white", unrestrictedRule),
      opponent: [
        publicHypothesis(
          position,
          "same-a",
          0.5,
          "black",
          unrestrictedRule,
        ),
        publicHypothesis(
          position,
          "same-b",
          0.5,
          "black",
          unrestrictedRule,
        ),
      ],
      unsupportedOpponentAuthorities: [],
      candidateMoves: [candidate],
      evaluator: { id: "must-not-run/no-authority-moves", evaluate },
      standardRepetitionAdjudicator: {
        id: "unused-standard-repetition",
        adjudicate,
      },
    });

    expect(result.status).toBe("complete");
    if (result.status !== "complete") {
      throw new Error("Expected a complete no-authority-moves assessment.");
    }
    expect(result.coverage.standardRepetitionAdjudicatorId).toBeNull();
    expect(result.moveAssessments[0]?.worstCase).toBe(999_999);
    expect(result.recommendations.ranked[0]).toMatchObject({
      informationGain: 0,
      replyBranches: [
        {
          reply: {
            kind: "terminal",
            terminal: {
              kind: "no-legal-moves",
              winner: "white",
              loser: "black",
            },
          },
          survivingHypothesisIds: ["same-a", "same-b"],
        },
      ],
    });
    expect(adjudicate).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();

    const session = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(29),
      fen,
    );
    expect(session.move({ from: "g7", to: "h8" })).toMatchObject({
      ok: true,
      result: {
        kind: "no-legal-moves",
        winner: "white",
        loser: "black",
      },
    });
  });
});

function allowUntilPlyRule(
  id: string,
  firstForbiddenPly: number,
): DrawbackRule<Record<string, never>, Record<string, never>> {
  return {
    id,
    name: id,
    description: "Test-only ply-gated move restriction.",
    verification: "verified",
    supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
    generateParameters: () => ({}),
    initialize: () => ({}),
    filterLegalMoves: (context, moves) =>
      context.position.ply < firstForbiddenPly ? moves : [],
    applyMove: () => ({}),
    checkStartOfTurnLoss: () => null,
  };
}

function allowOnlyMovesRule(
  id: string,
  allowedMoveIds: readonly string[],
): DrawbackRule<Record<string, never>, Record<string, never>> {
  return {
    id,
    name: id,
    description: "Test-only exact move restriction.",
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
  const parameters = rule.generateParameters(new Mulberry32(31));
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
  const parameters = rule.generateParameters(new Mulberry32(37));
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
