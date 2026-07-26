import type { PlayerColor } from "@drawbackengine/shared";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  RuleInitializationContext,
  RuleMoveContext,
  RuleTransitionContext,
} from "../types.js";
import {
  colorblindRule,
  filterColorblindMoves,
  filterHandAndBrainlessMoves,
  filterObsessionMoves,
  filterWindsOfFateMoves,
  forbiddenColorForTurn,
  forbiddenDirectionForTurn,
  handAndBrainlessRule,
  obsessionRule,
  obsessionSquareForTurn,
  requiredMoverTypeForTurn,
  type RerandomizedRuleState,
  type RerandomizedSeedParameters,
  windsOfFateRule,
} from "./rerandomized-rules.js";

const PARAMETERS: RerandomizedSeedParameters = { seed: 0x1234_5678 };

function move(
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly color?: PlayerColor;
    readonly captured?: PieceType;
    readonly promotion?: ChessMove["promotion"];
    readonly flags?: string;
  } = {},
): ChessMove {
  return {
    from,
    to,
    piece,
    color: options.color ?? "white",
    ...(options.captured === undefined ? {} : { captured: options.captured }),
    ...(options.promotion === undefined ? {} : { promotion: options.promotion }),
    san: `${from}${to}`,
    flags: options.flags ?? (options.captured === undefined ? "quiet" : "capture"),
  };
}

function initializationContext(
  color: PlayerColor,
  history: readonly ChessMove[] = [],
): RuleInitializationContext<RerandomizedSeedParameters> {
  return {
    color,
    parameters: PARAMETERS,
    position: {
      fen: `8/8/8/8/8/8/8/8 ${color === "white" ? "w" : "b"} - - 0 1`,
      turn: color,
      ply: history.length,
      history,
    },
  };
}

function moveContext<Constraint>(
  color: PlayerColor,
  currentConstraint: Constraint,
  movesApplied = 0,
): RuleMoveContext<
  RerandomizedRuleState<Constraint>,
  RerandomizedSeedParameters
> {
  return {
    ...initializationContext(color),
    state: { movesApplied, currentConstraint },
  };
}

function transitionContext<Constraint>(
  color: PlayerColor,
  currentConstraint: Constraint,
  movesApplied = 0,
): RuleTransitionContext<
  RerandomizedRuleState<Constraint>,
  RerandomizedSeedParameters
> {
  const before = moveContext(color, currentConstraint, movesApplied);
  return {
    ...before,
    positionAfterMove: {
      ...before.position,
      turn: color === "white" ? "black" : "white",
      ply: before.position.ply + 1,
    },
  };
}

describe("rerandomized selectors", () => {
  it("pins deterministic, domain-separated choices for successive own turns", () => {
    expect(Array.from({ length: 5 }, (_, turn) =>
      forbiddenColorForTurn(PARAMETERS, turn)
    )).toEqual(["light", "light", "dark", "dark", "dark"]);
    expect(Array.from({ length: 5 }, (_, turn) =>
      requiredMoverTypeForTurn(PARAMETERS, turn)
    )).toEqual(["rook", "pawn", "queen", "king", "bishop"]);
    expect(Array.from({ length: 5 }, (_, turn) =>
      obsessionSquareForTurn(PARAMETERS, turn)
    )).toEqual(["a4", "e1", "f4", "e5", "g1"]);
    expect(Array.from({ length: 5 }, (_, turn) =>
      forbiddenDirectionForTurn(PARAMETERS, turn)
    )).toEqual(["right", "left", "left", "right", "left"]);
  });

  it("rejects invalid seeds and turn counters", () => {
    expect(() => forbiddenColorForTurn({ seed: -1 }, 0)).toThrow(RangeError);
    expect(() => forbiddenColorForTurn({ seed: 0x1_0000_0000 }, 0))
      .toThrow(RangeError);
    expect(() => forbiddenColorForTurn(PARAMETERS, -1)).toThrow(RangeError);
    expect(() => forbiddenColorForTurn(PARAMETERS, 0.5)).toThrow(RangeError);
  });
});

describe("rerandomized rule state", () => {
  it("counts only the affected player's prior moves during initialization", () => {
    const history = [
      move("e2", "e4", "pawn"),
      move("e7", "e5", "pawn", { color: "black" }),
      move("g1", "f3", "knight"),
    ];

    expect(colorblindRule.initialize(initializationContext("white", history)))
      .toEqual({
        movesApplied: 2,
        currentConstraint: forbiddenColorForTurn(PARAMETERS, 2),
      });
    expect(colorblindRule.initialize(initializationContext("black", history)))
      .toEqual({
        movesApplied: 1,
        currentConstraint: forbiddenColorForTurn(PARAMETERS, 1),
      });
  });

  it("advances once after a move and selects the next turn's constraint", () => {
    const state = handAndBrainlessRule.applyMove(
      transitionContext("white", "rook", 0),
      move("a1", "a2", "rook"),
    );

    expect(state).toEqual({
      movesApplied: 1,
      currentConstraint: requiredMoverTypeForTurn(PARAMETERS, 1),
    });
  });

  it("keeps filtering idempotent and leaves frozen inputs untouched", () => {
    const moves = Object.freeze([
      move("a1", "a2", "rook"),
      move("b1", "c3", "knight"),
    ]);
    const context = moveContext<PieceType>("white", "rook");

    const first = handAndBrainlessRule.filterLegalMoves(context, moves);
    const second = handAndBrainlessRule.filterLegalMoves(context, moves);

    expect(first).toEqual([moves[0]]);
    expect(second).toEqual(first);
    expect(first).not.toBe(moves);
    expect(moves).toHaveLength(2);
  });
});

describe("Colorblind move filtering", () => {
  it("filters by destination color, including promotion, en passant, and castling", () => {
    const darkPromotion = move("a7", "a8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    const lightEnPassant = move("e5", "d6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });
    const darkWhiteCastle = move("e1", "g1", "king", { flags: "kingside-castle" });
    const lightBlackCastle = move("e8", "c8", "king", {
      color: "black",
      flags: "queenside-castle",
    });

    expect(filterColorblindMoves("dark", [
      darkPromotion,
      lightEnPassant,
      darkWhiteCastle,
      lightBlackCastle,
    ])).toEqual([darkPromotion, lightBlackCastle]);
    expect(filterColorblindMoves("light", [
      darkPromotion,
      lightEnPassant,
      darkWhiteCastle,
      lightBlackCastle,
    ])).toEqual([lightEnPassant, darkWhiteCastle]);
  });

  it("returns an empty mask rather than falling back when all moves are forbidden", () => {
    expect(filterColorblindMoves("dark", [
      move("a1", "b2", "bishop"),
      move("e1", "g1", "king", { flags: "kingside-castle" }),
    ])).toEqual([]);
  });
});

describe("Hand and Brainless move filtering", () => {
  it("classifies promotion by its pawn mover and castling by its king mover", () => {
    const promotion = move("a7", "a8", "pawn", {
      promotion: "rook",
      flags: "promotion",
    });
    const castle = move("e1", "g1", "king", { flags: "kingside-castle" });

    expect(filterHandAndBrainlessMoves("pawn", [promotion, castle]))
      .toEqual([promotion]);
    expect(filterHandAndBrainlessMoves("king", [promotion, castle]))
      .toEqual([castle]);
  });

  it("returns an empty mask when the required type has no ordinary move", () => {
    expect(filterHandAndBrainlessMoves("queen", [
      move("a2", "a3", "pawn"),
      move("g1", "f3", "knight"),
    ])).toEqual([]);
  });
});

describe("Obsession move filtering", () => {
  it("forces every move reaching the target, including all promotion choices", () => {
    const promotions = (["queen", "rook", "bishop", "knight"] as const)
      .map((promotion) =>
        move("a7", "a8", "pawn", { promotion, flags: "promotion" })
      );
    const other = move("h2", "h3", "pawn");

    expect(filterObsessionMoves("a8", [...promotions, other]))
      .toEqual(promotions);
  });

  it("uses primary landing squares for en passant and castling", () => {
    const enPassant = move("e5", "d6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });
    const castle = move("e1", "g1", "king", { flags: "kingside-castle" });
    const quiet = move("a2", "a3", "pawn");

    expect(filterObsessionMoves("d6", [enPassant, castle, quiet]))
      .toEqual([enPassant]);
    expect(filterObsessionMoves("g1", [enPassant, castle, quiet]))
      .toEqual([castle]);
  });

  it("returns a fresh unrestricted mask when the target is unreachable", () => {
    const moves = Object.freeze([
      move("a2", "a3", "pawn"),
      move("b1", "c3", "knight"),
    ]);
    const result = filterObsessionMoves("h8", moves);

    expect(result).toEqual(moves);
    expect(result).not.toBe(moves);
    expect(filterObsessionMoves("h8", [])).toEqual([]);
  });
});

describe("Winds of Fate move filtering", () => {
  const whiteLeft = move("d4", "c4", "rook");
  const whiteRight = move("d4", "e4", "rook");
  const vertical = move("d4", "d5", "rook");

  it("uses player-relative directions and mirrors them for Black", () => {
    const blackTowardA = move("d5", "c5", "rook", { color: "black" });
    const blackTowardH = move("d5", "e5", "rook", { color: "black" });

    expect(filterWindsOfFateMoves("white", "left", [
      whiteLeft,
      whiteRight,
      vertical,
    ])).toEqual([whiteRight, vertical]);
    expect(filterWindsOfFateMoves("black", "left", [
      blackTowardA,
      blackTowardH,
      vertical,
    ])).toEqual([blackTowardA, vertical]);
  });

  it("uses file delta for knights, diagonal moves, promotions, and en passant", () => {
    const knightLeft = move("e4", "c5", "knight");
    const diagonalRight = move("c1", "h6", "bishop");
    const capturePromotionLeft = move("b7", "a8", "pawn", {
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    const enPassantRight = move("e5", "f6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });
    const straightPromotion = move("a7", "a8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });

    expect(filterWindsOfFateMoves("white", "left", [
      knightLeft,
      diagonalRight,
      capturePromotionLeft,
      enPassantRight,
      straightPromotion,
    ])).toEqual([diagonalRight, enPassantRight, straightPromotion]);
  });

  it("classifies castling by the king's primary direction", () => {
    const kingside = move("e1", "g1", "king", { flags: "kingside-castle" });
    const queenside = move("e1", "c1", "king", { flags: "queenside-castle" });

    expect(filterWindsOfFateMoves("white", "right", [kingside, queenside]))
      .toEqual([queenside]);
    expect(filterWindsOfFateMoves("white", "left", [kingside, queenside]))
      .toEqual([kingside]);
  });

  it("returns an empty mask rather than falling back when every move is forbidden", () => {
    expect(filterWindsOfFateMoves("white", "right", [
      whiteRight,
      move("b1", "c3", "knight"),
    ])).toEqual([]);
  });

  it("applies the state-held direction through the executable rule", () => {
    const result = windsOfFateRule.filterLegalMoves(
      moveContext("white", "left"),
      [whiteLeft, whiteRight, vertical],
    );
    expect(result).toEqual([whiteRight, vertical]);
  });
});

describe("executable rerandomized rule masks", () => {
  it("applies Colorblind, Hand and Brainless, and Obsession state constraints", () => {
    const dark = move("a1", "b2", "bishop");
    const light = move("a1", "a2", "rook");
    expect(colorblindRule.filterLegalMoves(
      moveContext("white", "dark"),
      [dark, light],
    )).toEqual([light]);

    expect(handAndBrainlessRule.filterLegalMoves(
      moveContext("white", "rook"),
      [dark, light],
    )).toEqual([light]);

    expect(obsessionRule.filterLegalMoves(
      moveContext("white", "b2"),
      [dark, light],
    )).toEqual([dark]);

    expect(colorblindRule.describeTurn?.(
      moveContext("white", "dark"),
    )).toEqual(["Forbidden destination: dark squares"]);
    expect(handAndBrainlessRule.describeTurn?.(
      moveContext("white", "rook"),
    )).toEqual(["Required mover: rook"]);
    expect(obsessionRule.describeTurn?.(
      moveContext("white", "b2"),
    )).toEqual(["Target square: b2"]);
    expect(windsOfFateRule.describeTurn?.(
      moveContext("white", "left"),
    )).toEqual(["Forbidden direction: left"]);
  });
});
