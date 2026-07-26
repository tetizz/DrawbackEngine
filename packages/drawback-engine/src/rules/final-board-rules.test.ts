import type { PlayerColor } from "@drawbackengine/shared";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  RuleMoveContext,
} from "../types.js";
import type {
  NoParameters,
  StatelessRuleState,
} from "./common.js";
import {
  eyeOfSauronFrontier,
  eyeOfSauronRule,
  finalBoardRules,
  horizontallyReflectedSquare,
  reflectiveRule,
} from "./final-board-rules.js";

function move(
  color: PlayerColor,
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
    ...(options.captured === undefined ? {} : { captured: options.captured }),
    ...(options.promotion === undefined ? {} : { promotion: options.promotion }),
    san: `${from}${to}`,
    flags: options.flags ?? (options.captured === undefined ? "quiet" : "capture"),
  };
}

function context(
  fen: string,
  color: PlayerColor = "white",
  state: StatelessRuleState = { movesApplied: 0 },
): RuleMoveContext<StatelessRuleState, NoParameters> {
  return {
    color,
    parameters: {},
    state,
    position: {
      fen,
      turn: color,
      ply: 0,
      history: [],
    },
  };
}

describe("final board rule metadata", () => {
  it("publishes two executable but unverified rules", () => {
    expect(finalBoardRules.map((rule) => rule.id)).toEqual([
      "reflective",
      "eye-of-sauron",
    ]);
    expect(finalBoardRules.every(
      (rule) => rule.verification === "implemented-unverified",
    )).toBe(true);
  });
});

describe("Reflective", () => {
  it("reflects ranks across the horizontal center line", () => {
    expect(horizontallyReflectedSquare("a1")).toBe("a8");
    expect(horizontallyReflectedSquare("d3")).toBe("d6");
    expect(horizontallyReflectedSquare("h8")).toBe("h1");
    expect(() => horizontallyReflectedSquare("z9")).toThrow(RangeError);
  });

  it("accepts either color of pre-move occupant and rejects an empty mirror", () => {
    const fen = "4k3/8/3p4/8/8/8/8/R3K2R w KQ - 0 1";
    const ownOriginIsMirror = move("white", "a1", "a8", "rook");
    const opponentOccupiesMirror = move("white", "h1", "d3", "rook");
    const emptyMirror = move("white", "h1", "h3", "rook");

    expect(reflectiveRule.filterLegalMoves(
      context(fen),
      [ownOriginIsMirror, opponentOccupiesMirror, emptyMirror],
    )).toEqual([ownOriginIsMirror, opponentOccupiesMirror]);
  });

  it("exempts pawn moves, including promotion and en passant", () => {
    const fen = "4k3/P7/8/4Pp2/8/8/8/4K3 w - f6 0 1";
    const promotion = move("white", "a7", "a8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    const enPassant = move("white", "e5", "f6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });

    expect(reflectiveRule.filterLegalMoves(
      context(fen),
      [promotion, enPassant],
    )).toEqual([promotion, enPassant]);
  });

  it("classifies castling by the primary king destination", () => {
    const fen = "2n1k1n1/8/8/8/8/8/8/R3K2R w KQ - 0 1";
    const kingside = move("white", "e1", "g1", "king", {
      flags: "kingside-castle",
    });
    const queenside = move("white", "e1", "c1", "king", {
      flags: "queenside-castle",
    });

    expect(reflectiveRule.filterLegalMoves(
      context(fen),
      [kingside, queenside],
    )).toEqual([kingside, queenside]);
  });

  it("mirrors identically for Black and preserves immutable inputs", () => {
    const fen = "4k3/8/8/8/8/3P4/8/4K2r b - - 0 1";
    const allowed = move("black", "h1", "d6", "rook");
    const forbidden = move("black", "h1", "h6", "rook");
    const moves = Object.freeze([allowed, forbidden]);
    const result = reflectiveRule.filterLegalMoves(
      context(fen, "black"),
      moves,
    );

    expect(result).toEqual([allowed]);
    expect(result).not.toBe(moves);
    expect(moves).toHaveLength(2);
  });

  it("returns an empty mask when every non-pawn mirror is empty", () => {
    const fen = "4k3/8/8/8/8/8/8/4K1N1 w - - 0 1";
    expect(reflectiveRule.filterLegalMoves(context(fen), [
      move("white", "g1", "f3", "knight"),
      move("white", "g1", "h3", "knight"),
    ])).toEqual([]);
  });
});

describe("Eye of Sauron", () => {
  it("uses own rook origins and ordinary rook destinations for the frontier", () => {
    const fen = "4k3/8/8/8/8/8/R7/4K3 w - - 0 1";
    const rookMoves = [
      move("white", "a2", "a6", "rook"),
      move("white", "a2", "h2", "rook"),
    ];
    expect(eyeOfSauronFrontier("white", fen, rookMoves)).toBe(6);
    expect(eyeOfSauronFrontier("white", fen, [])).toBe(2);
  });

  it("filters non-pawns beyond White's frontier while exempting pawns", () => {
    const fen = "4k3/8/8/8/8/8/R3P3/1N2K3 w - - 0 1";
    const rookReach = move("white", "a2", "a4", "rook");
    const knightAtFrontier = move("white", "b1", "c3", "knight");
    const knightBeyond = move("white", "b1", "d5", "knight");
    const pawnBeyond = move("white", "e2", "e5", "pawn");

    expect(eyeOfSauronRule.filterLegalMoves(context(fen), [
      rookReach,
      knightAtFrontier,
      knightBeyond,
      pawnBeyond,
    ])).toEqual([rookReach, knightAtFrontier, pawnBeyond]);
  });

  it("mirrors advancement for Black", () => {
    const fen = "4k1n1/r7/8/8/8/8/4p3/4K3 b - - 0 1";
    const rookReach = move("black", "a7", "a5", "rook");
    const knightAtFrontier = move("black", "g8", "f6", "knight");
    const knightBeyond = move("black", "g8", "e4", "knight");
    const pawnBeyond = move("black", "e2", "e1", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });

    expect(eyeOfSauronRule.filterLegalMoves(context(fen, "black"), [
      rookReach,
      knightAtFrontier,
      knightBeyond,
      pawnBeyond,
    ])).toEqual([rookReach, knightAtFrontier, pawnBeyond]);
  });

  it("falls back to a fresh unrestricted mask when no rook survives", () => {
    const fen = "4k3/8/8/8/8/8/4P3/1N2K3 w - - 0 1";
    const moves = Object.freeze([
      move("white", "b1", "c3", "knight"),
      move("white", "e2", "e4", "pawn"),
    ]);
    const result = eyeOfSauronRule.filterLegalMoves(context(fen), moves);

    expect(result).toEqual(moves);
    expect(result).not.toBe(moves);
  });

  it("treats promoted rooks as rooks and keeps en passant exempt", () => {
    const fen = "R3k3/8/8/4Pp2/8/8/8/4K3 w - f6 0 1";
    const enPassant = move("white", "e5", "f6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });
    expect(eyeOfSauronFrontier("white", fen, [])).toBe(8);
    expect(eyeOfSauronRule.filterLegalMoves(context(fen), [enPassant]))
      .toEqual([enPassant]);
  });

  it("checks castling by the king destination and permits rook moves in the frontier", () => {
    const fen = "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1";
    const rookReach = move("white", "a1", "a2", "rook");
    const kingside = move("white", "e1", "g1", "king", {
      flags: "kingside-castle",
    });
    const queenside = move("white", "e1", "c1", "king", {
      flags: "queenside-castle",
    });
    expect(eyeOfSauronRule.filterLegalMoves(context(fen), [
      rookReach,
      kingside,
      queenside,
    ])).toEqual([rookReach, kingside, queenside]);
  });

  it("can return an empty mask when a rook exists but all listed non-pawns exceed its origin frontier", () => {
    const fen = "4k3/8/8/8/8/8/8/R3K1N1 w - - 0 1";
    expect(eyeOfSauronRule.filterLegalMoves(context(fen), [
      move("white", "g1", "f3", "knight"),
      move("white", "e1", "e2", "king"),
    ])).toEqual([]);
  });
});
