import { describe, expect, it } from "vitest";
import type { PlayerColor } from "@drawbackengine/shared";
import type {
  ExternalTurnConstraint,
  ExternalTurnConstraintRequest,
} from "../external-constraints.js";
import type {
  ChessMove,
  PieceType,
  PositionView,
  PromotionPiece,
  RuleMoveContext,
} from "../types.js";
import type { NoParameters } from "./common.js";
import {
  canonicalMoveUci,
  handAndGigabrainRule,
  ichtyophobeRule,
  type EvaluatorBackedRuleState,
} from "./evaluator-backed-rules.js";

function move(
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly color?: PlayerColor;
    readonly captured?: PieceType;
    readonly promotion?: PromotionPiece;
    readonly flags?: string;
  } = {},
): ChessMove {
  return {
    from,
    to,
    color: options.color ?? "white",
    piece,
    ...(options.captured === undefined
      ? {}
      : { captured: options.captured }),
    ...(options.promotion === undefined
      ? {}
      : { promotion: options.promotion }),
    san: `${from}-${to}`,
    flags: options.flags ?? "quiet",
  };
}

function position(
  history: readonly ChessMove[] = [],
  fen = "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
): PositionView {
  return { fen, turn: "white", ply: history.length, history };
}

function context(
  history: readonly ChessMove[] = [],
): RuleMoveContext<EvaluatorBackedRuleState, NoParameters> {
  return {
    color: "white",
    parameters: {},
    state: { movesApplied: 0 },
    position: position(history),
  };
}

function prepared(
  request: ExternalTurnConstraintRequest,
  bestMoveUci: string,
): ExternalTurnConstraint {
  return {
    provider: request.provider,
    policyId: request.policyId,
    positionKey: request.positionKey,
    requestDigest: "ab".repeat(32),
    bestMoveUci,
    engineFingerprint: "stockfish-test",
  };
}

describe("external evaluator-backed drawback rules", () => {
  it("requests the complete ordinary root mask in canonical UCI", () => {
    const ordinary = [
      move("e2", "e4", "pawn"),
      move("e7", "e8", "pawn", { promotion: "queen" }),
      move("e7", "f8", "pawn", {
        captured: "rook",
        promotion: "knight",
      }),
    ];
    const snapshot = structuredClone(ordinary);
    const request = handAndGigabrainRule.requestTurnConstraint(
      context(),
      ordinary,
    );

    expect(request).toMatchObject({
      provider: "uci-best-move",
      policyId: "stockfish-bestmove-v1",
      fen: context().position.fen,
      ordinaryRootMoves: ["e2e4", "e7e8q", "e7f8n"],
    });
    expect(request.positionKey).toContain(context().position.fen);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.ordinaryRootMoves)).toBe(true);
    expect(ordinary).toEqual(snapshot);
  });

  it("retains every move of the best move's mover type", () => {
    const ordinary = [
      move("b1", "c3", "knight"),
      move("g1", "f3", "knight"),
      move("e2", "e4", "pawn"),
      move("e1", "g1", "king", { flags: "kingside-castle" }),
    ];
    const request = handAndGigabrainRule.requestTurnConstraint(
      context(),
      ordinary,
    );
    expect(
      handAndGigabrainRule.filterLegalMovesWithConstraint(
        context(),
        ordinary,
        prepared(request, "g1f3"),
      ),
    ).toEqual([ordinary[0], ordinary[1]]);
  });

  it("classifies promotions and en-passant by their pawn mover", () => {
    const ordinary = [
      move("e7", "e8", "pawn", { promotion: "queen" }),
      move("e5", "d6", "pawn", {
        captured: "pawn",
        flags: "en-passant",
      }),
      move("a1", "a8", "rook"),
    ];
    const request = handAndGigabrainRule.requestTurnConstraint(
      context(),
      ordinary,
    );
    expect(
      handAndGigabrainRule.filterLegalMovesWithConstraint(
        context(),
        ordinary,
        prepared(request, "e7e8q"),
      ),
    ).toEqual([ordinary[0], ordinary[1]]);
  });

  it("classifies castling by its king mover", () => {
    const ordinary = [
      move("e1", "g1", "king", { flags: "kingside-castle" }),
      move("e1", "f1", "king"),
      move("h1", "g1", "rook"),
    ];
    const request = handAndGigabrainRule.requestTurnConstraint(
      context(),
      ordinary,
    );
    expect(
      handAndGigabrainRule.filterLegalMovesWithConstraint(
        context(),
        ordinary,
        prepared(request, "e1g1"),
      ),
    ).toEqual([ordinary[0], ordinary[1]]);
  });

  it("Ichtyophobe removes only the exact promoted best move", () => {
    const ordinary = [
      move("e7", "e8", "pawn", { promotion: "queen" }),
      move("e7", "e8", "pawn", { promotion: "rook" }),
      move("e7", "e8", "pawn", { promotion: "bishop" }),
      move("e7", "e8", "pawn", { promotion: "knight" }),
    ];
    const request = ichtyophobeRule.requestTurnConstraint(
      context(),
      ordinary,
    );
    expect(
      ichtyophobeRule.filterLegalMovesWithConstraint(
        context(),
        ordinary,
        prepared(request, "e7e8q"),
      ),
    ).toEqual([ordinary[1], ordinary[2], ordinary[3]]);
  });

  it("handles one-move roots without unrestricted fallbacks", () => {
    const onlyMove = move("e1", "f1", "king");
    const ordinary = [onlyMove];
    const handRequest = handAndGigabrainRule.requestTurnConstraint(
      context(),
      ordinary,
    );
    const fishRequest = ichtyophobeRule.requestTurnConstraint(
      context(),
      ordinary,
    );

    expect(
      handAndGigabrainRule.filterLegalMovesWithConstraint(
        context(),
        ordinary,
        prepared(handRequest, "e1f1"),
      ),
    ).toEqual([onlyMove]);
    expect(
      ichtyophobeRule.filterLegalMovesWithConstraint(
        context(),
        ordinary,
        prepared(fishRequest, "e1f1"),
      ),
    ).toEqual([]);
  });

  it("rejects missing, stale, mismatched, malformed, and out-of-mask constraints", () => {
    const ordinary = [move("e2", "e4", "pawn"), move("d2", "d4", "pawn")];
    const request = handAndGigabrainRule.requestTurnConstraint(
      context(),
      ordinary,
    );
    const valid = prepared(request, "e2e4");
    const filter = (constraint: ExternalTurnConstraint) =>
      handAndGigabrainRule.filterLegalMovesWithConstraint(
        context(),
        ordinary,
        constraint,
      );

    expect(() =>
      filter(undefined as unknown as ExternalTurnConstraint),
    ).toThrow("required");
    expect(() =>
      filter({ ...valid, provider: "other" as "uci-best-move" }),
    ).toThrow("provider");
    expect(() => filter({ ...valid, policyId: "other" })).toThrow("policy");
    expect(() => filter({ ...valid, positionKey: "stale" })).toThrow(
      "position",
    );
    expect(() => filter({ ...valid, engineFingerprint: " " })).toThrow(
      "fingerprint",
    );
    expect(() => filter({ ...valid, requestDigest: "not-a-digest" })).toThrow(
      "request digest",
    );
    expect(() => filter({ ...valid, bestMoveUci: "E2E4" })).toThrow(
      "canonical UCI",
    );
    expect(() => filter({ ...valid, bestMoveUci: "e2e5" })).toThrow(
      "outside",
    );
  });

  it("does not mutate moves, constraints, or prior state", () => {
    const ordinary = [
      move("b1", "c3", "knight"),
      move("e2", "e4", "pawn"),
    ];
    const ordinarySnapshot = structuredClone(ordinary);
    const request = handAndGigabrainRule.requestTurnConstraint(
      context(),
      ordinary,
    );
    const constraint = Object.freeze(prepared(request, "b1c3"));
    const constraintSnapshot = structuredClone(constraint);
    const state: EvaluatorBackedRuleState = { movesApplied: 3 };

    const filtered = handAndGigabrainRule.filterLegalMovesWithConstraint(
      { ...context(), state },
      ordinary,
      constraint,
    );
    const next = handAndGigabrainRule.applyMove(
      {
        ...context(),
        state,
        positionAfterMove: position([ordinary[0] as ChessMove]),
      },
      ordinary[0] as ChessMove,
    );

    expect(filtered).not.toBe(ordinary);
    expect(ordinary).toEqual(ordinarySnapshot);
    expect(constraint).toEqual(constraintSnapshot);
    expect(state).toEqual({ movesApplied: 3 });
    expect(next).toEqual({ movesApplied: 4 });
    expect(Object.isFrozen(next)).toBe(true);
  });

  it("tracks only the affected player's completed moves", () => {
    const whiteMove = move("e2", "e4", "pawn", { color: "white" });
    const blackMove = move("e7", "e5", "pawn", { color: "black" });
    expect(
      handAndGigabrainRule.initialize({
        color: "black",
        parameters: {},
        position: {
          fen: "4k3/8/8/8/8/8/8/4K3 b - - 0 1",
          turn: "black",
          ply: 3,
          history: [whiteMove, blackMove, whiteMove],
        },
      }),
    ).toEqual({ movesApplied: 1 });
  });

  it("rejects malformed ordinary moves before preparing a request", () => {
    expect(() =>
      canonicalMoveUci(move("z9", "e4", "pawn")),
    ).toThrow("canonical UCI");
  });
});
