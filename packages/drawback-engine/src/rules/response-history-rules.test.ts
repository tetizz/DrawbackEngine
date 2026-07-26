import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  DrawbackRule,
  PieceType,
  RuleMoveContext,
} from "../types.js";
import type { NoParameters, StatelessRuleState } from "./common.js";
import {
  boxingWithShadowRule,
  cowardlyRule,
  goingTheDistanceRule,
  leftToRightRule,
  relayRaceRule,
  religiousDisputeRule,
  responseHistoryRules,
  simonSaysRule,
  stirCrazyRule,
  superstitiousRule,
  torpedosRule,
} from "./response-history-rules.js";

const BASE_FEN = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";

function move(
  color: ChessMove["color"],
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly captured?: PieceType;
    readonly promotion?: ChessMove["promotion"];
    readonly flags?: string;
  } = {},
): ChessMove {
  return {
    color,
    from,
    to,
    piece,
    san: `${from}-${to}`,
    flags: options.flags ??
      (options.captured === undefined ? "quiet" : "capture"),
    ...(options.captured === undefined ? {} : { captured: options.captured }),
    ...(options.promotion === undefined ? {} : { promotion: options.promotion }),
  };
}

function context(
  color: ChessMove["color"],
  history: readonly ChessMove[],
): RuleMoveContext<StatelessRuleState, NoParameters> {
  return {
    color,
    parameters: {},
    state: { movesApplied: history.filter((entry) => entry.color === color).length },
    position: {
      fen: BASE_FEN,
      turn: color,
      ply: history.length,
      history,
    },
  };
}

function allowed(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
  candidates: readonly ChessMove[],
  history: readonly ChessMove[] = [],
  color: ChessMove["color"] = "white",
): readonly ChessMove[] {
  return rule.filterLegalMoves(context(color, history), candidates);
}

describe("response history rules", () => {
  it("has unique metadata and never mutates ordinary moves", () => {
    expect(responseHistoryRules).toHaveLength(10);
    expect(new Set(responseHistoryRules.map(({ id }) => id)).size).toBe(10);
    const candidate = Object.freeze(move("white", "a2", "a3", "pawn"));
    const ordinary = Object.freeze([candidate]);
    for (const rule of responseHistoryRules) {
      const result = rule.filterLegalMoves(context("white", []), ordinary);
      expect(result).not.toBe(ordinary);
      expect(ordinary).toEqual([candidate]);
      expect(rule.verification).toBe("implemented-unverified");
    }
  });

  it("Boxing with Shadow forces the opponent's origin only when reachable", () => {
    const previous = move("black", "c6", "d4", "knight");
    const shadow = move("white", "b4", "c6", "bishop");
    const other = move("white", "e2", "e4", "pawn");
    expect(allowed(boxingWithShadowRule, [shadow, other], [previous]))
      .toEqual([shadow]);
    expect(allowed(boxingWithShadowRule, [other], [previous])).toEqual([other]);
  });

  it("Cowardly requires strict color-relative backward movement after a capture", () => {
    const capture = move("black", "d5", "e4", "pawn", {
      captured: "pawn",
    });
    const backward = move("white", "d4", "d3", "rook");
    const level = move("white", "d4", "e4", "rook");
    const forward = move("white", "d4", "d5", "rook");
    expect(allowed(cowardlyRule, [backward, level, forward], [capture]))
      .toEqual([backward]);

    const blackBackward = move("black", "d5", "d6", "rook");
    const blackForward = move("black", "d5", "d4", "rook");
    expect(allowed(
      cowardlyRule,
      [blackBackward, blackForward],
      [move("white", "a2", "b3", "pawn", { captured: "pawn" })],
      "black",
    )).toEqual([blackBackward]);
  });

  it("Cowardly is inactive after a quiet opponent move", () => {
    const candidates = [
      move("white", "d4", "d3", "rook"),
      move("white", "d4", "d5", "rook"),
    ];
    expect(allowed(
      cowardlyRule,
      candidates,
      [move("black", "a7", "a6", "pawn")],
    )).toEqual(candidates);
  });

  it("Going the Distance compares Manhattan distances including knight moves", () => {
    const previous = move("black", "a8", "a5", "rook");
    const shorter = move("white", "a1", "a3", "rook");
    const equalKnight = move("white", "b1", "c3", "knight");
    const longer = move("white", "a1", "e1", "rook");
    expect(allowed(
      goingTheDistanceRule,
      [shorter, equalKnight, longer],
      [previous],
    )).toEqual([equalKnight, longer]);
  });

  it("Left to Right uses absolute files and resets after the h-file", () => {
    const previous = move("white", "b2", "d4", "bishop");
    const left = move("white", "a2", "c3", "pawn");
    const right = move("white", "e2", "f3", "bishop");
    expect(allowed(leftToRightRule, [left, right], [previous]))
      .toEqual([right]);
    expect(allowed(
      leftToRightRule,
      [left, right],
      [move("white", "g2", "h3", "bishop")],
    )).toEqual([left, right]);
  });

  it("Relay Race forces all movers adjacent to the previous own destination", () => {
    const previous = move("white", "e2", "e4", "pawn");
    const diagonal = move("white", "d3", "d4", "rook");
    const orthogonal = move("white", "e3", "e5", "rook");
    const far = move("white", "a2", "a3", "pawn");
    expect(allowed(
      relayRaceRule,
      [diagonal, orthogonal, far],
      [previous],
    )).toEqual([diagonal, orthogonal]);
    expect(allowed(relayRaceRule, [far], [previous])).toEqual([far]);
  });

  it("Religious Dispute forces bishops after an opponent bishop move", () => {
    const previous = move("black", "c8", "f5", "bishop");
    const bishop = move("white", "c1", "g5", "bishop");
    const promotion = move("white", "a7", "a8", "pawn", {
      promotion: "bishop",
      flags: "promotion",
    });
    const castle = move("white", "e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(allowed(
      religiousDisputeRule,
      [bishop, promotion, castle],
      [previous],
    )).toEqual([bishop]);
  });

  it("Simon Says matches the opponent destination's square color", () => {
    const previous = move("black", "e7", "e5", "pawn");
    const same = move("white", "b1", "c3", "knight");
    const opposite = move("white", "g1", "f3", "knight");
    expect(allowed(simonSaysRule, [same, opposite], [previous]))
      .toEqual([same]);
  });

  it("Superstitious permanently curses only opponent capture landing squares", () => {
    const opponentCapture = move("black", "c6", "d4", "knight", {
      captured: "pawn",
    });
    const ownCapture = move("white", "a2", "b3", "pawn", {
      captured: "pawn",
    });
    const cursed = move("white", "f3", "d4", "knight");
    const ownOnly = move("white", "c1", "b2", "bishop");
    expect(allowed(
      superstitiousRule,
      [cursed, ownOnly],
      [opponentCapture, ownCapture],
    )).toEqual([ownOnly]);
  });

  it("Superstitious treats an en-passant landing square as cursed", () => {
    const enPassant = move("black", "e4", "d3", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const landing = move("white", "f2", "d3", "knight");
    const removedPawnSquare = move("white", "f4", "d4", "bishop");
    expect(allowed(
      superstitiousRule,
      [landing, removedPawnSquare],
      [enPassant],
    )).toEqual([removedPawnSquare]);
  });

  it("Torpedos forces the same physical piece and follows quiet promotion", () => {
    const previous = move("white", "e2", "e4", "pawn");
    const samePawn = move("white", "e4", "e5", "pawn");
    const other = move("white", "a2", "a3", "pawn");
    expect(allowed(torpedosRule, [samePawn, other], [previous]))
      .toEqual([samePawn]);

    const promotion = move("white", "a7", "a8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    const promotedPiece = move("white", "a8", "b8", "queen");
    expect(allowed(torpedosRule, [promotedPiece, other], [promotion]))
      .toEqual([promotedPiece]);
  });

  it("Torpedos is inactive after a capture or when the piece cannot move", () => {
    const candidates = [move("white", "a2", "a3", "pawn")];
    expect(allowed(
      torpedosRule,
      candidates,
      [move("white", "e4", "d5", "pawn", { captured: "pawn" })],
    )).toEqual(candidates);
    expect(allowed(
      torpedosRule,
      candidates,
      [move("white", "e2", "e4", "pawn")],
    )).toEqual(candidates);
  });

  it("Stir Crazy forces a king after four own non-king turns and resets on king movement", () => {
    const own = [
      move("white", "a2", "a3", "pawn"),
      move("white", "b2", "b3", "pawn"),
      move("white", "c2", "c3", "pawn"),
      move("white", "d2", "d3", "pawn"),
    ];
    const king = move("white", "e1", "f1", "king");
    const pawn = move("white", "e2", "e3", "pawn");
    expect(allowed(stirCrazyRule, [king, pawn], own)).toEqual([king]);
    expect(allowed(
      stirCrazyRule,
      [king, pawn],
      [...own.slice(0, 3), king],
    )).toEqual([king, pawn]);
  });

  it("Stir Crazy counts affected-player turns rather than plies", () => {
    const history = [
      move("white", "a2", "a3", "pawn"),
      move("black", "a7", "a6", "pawn"),
      move("white", "b2", "b3", "pawn"),
      move("black", "b7", "b6", "pawn"),
      move("white", "c2", "c3", "pawn"),
      move("black", "c7", "c6", "pawn"),
      move("white", "d2", "d3", "pawn"),
    ];
    const castle = move("white", "e1", "g1", "king", {
      flags: "kingside-castle",
    });
    const pawn = move("white", "e2", "e3", "pawn");
    expect(allowed(stirCrazyRule, [castle, pawn], history))
      .toEqual([castle]);
  });
});
