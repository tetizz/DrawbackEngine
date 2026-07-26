import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  PromotionPiece,
  RuleMoveContext,
  RuleTransitionContext,
} from "../types.js";
import {
  checkersRule,
  lameDuckRule,
  spiceOfLifeRule,
  truantRule,
  veganRule,
} from "./index.js";
import type {
  NoParameters,
  SpiceOfLifeState,
  StatelessRuleState,
  TruantState,
} from "./index.js";

interface MoveInput {
  readonly from: string;
  readonly to: string;
  readonly piece: PieceType;
  readonly captured?: PieceType;
  readonly promotion?: PromotionPiece;
  readonly flags?: string;
  readonly san?: string;
}

function move(input: MoveInput): ChessMove {
  return {
    from: input.from,
    to: input.to,
    color: "white",
    piece: input.piece,
    ...(input.captured === undefined ? {} : { captured: input.captured }),
    ...(input.promotion === undefined ? {} : { promotion: input.promotion }),
    san: input.san ?? `${input.from}-${input.to}`,
    flags: input.flags ?? (input.captured === undefined ? "quiet" : "capture"),
  };
}

const position = {
  fen: "test-fen",
  turn: "white" as const,
  ply: 0,
  history: [] as const,
};

function statelessContext(): RuleMoveContext<StatelessRuleState, NoParameters> {
  return { color: "white", parameters: {}, state: { movesApplied: 0 }, position };
}

function truantContext(
  previousMoverDestination: string | null,
): RuleMoveContext<TruantState, NoParameters> {
  return { color: "white", parameters: {}, state: { previousMoverDestination }, position };
}

function spiceContext(
  previousMoverType: PieceType | null,
): RuleMoveContext<SpiceOfLifeState, NoParameters> {
  return { color: "white", parameters: {}, state: { previousMoverType }, position };
}

describe("Vegan", () => {
  it("forbids every capture of a knight but permits knight movers and other captures", () => {
    const input = [
      move({ from: "c3", to: "b5", piece: "knight" }),
      move({ from: "c3", to: "d5", piece: "knight", captured: "pawn" }),
      move({ from: "c4", to: "d5", piece: "pawn", captured: "knight" }),
    ];
    expect(veganRule.filterLegalMoves(statelessContext(), input)).toEqual(input.slice(0, 2));
  });

  it("forbids a capturing promotion when the captured target is a knight", () => {
    const forbidden = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "knight",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(veganRule.filterLegalMoves(statelessContext(), [forbidden])).toEqual([]);
  });

  it("does not affect castling, non-capturing promotion, or en-passant", () => {
    const unaffected = [
      move({ from: "e1", to: "g1", piece: "king", flags: "quiet,kingside-castle" }),
      move({
        from: "a7",
        to: "a8",
        piece: "pawn",
        promotion: "queen",
        flags: "quiet,promotion",
      }),
      move({
        from: "e5",
        to: "d6",
        piece: "pawn",
        captured: "pawn",
        flags: "capture,en-passant",
      }),
    ];
    expect(veganRule.filterLegalMoves(statelessContext(), unaffected)).toEqual(unaffected);
  });

  it("returns an empty set when every ordinary legal move captures a knight", () => {
    const capturesKnight = move({
      from: "c4",
      to: "d5",
      piece: "pawn",
      captured: "knight",
    });
    expect(veganRule.filterLegalMoves(statelessContext(), [capturesKnight])).toEqual([]);
  });

  it("does not define a start-of-turn loss", () => {
    expect(veganRule.checkStartOfTurnLoss(statelessContext())).toBeNull();
  });

  it("does not mutate the ordinary legal move array", () => {
    const input = [move({ from: "e2", to: "e4", piece: "pawn" })];
    const output = veganRule.filterLegalMoves(statelessContext(), input);
    expect(output).not.toBe(input);
    expect(input).toHaveLength(1);
  });
});

describe("Lame Duck", () => {
  it("forbids quiet king moves and king captures", () => {
    const rook = move({ from: "a1", to: "a2", piece: "rook" });
    const quietKing = move({ from: "e1", to: "e2", piece: "king" });
    const kingCapture = move({ from: "e1", to: "d2", piece: "king", captured: "pawn" });
    expect(lameDuckRule.filterLegalMoves(statelessContext(), [rook, quietKing, kingCapture]))
      .toEqual([rook]);
  });

  it("forbids both forms of castling because the primary mover is the king", () => {
    const castles = [
      move({ from: "e1", to: "g1", piece: "king", flags: "quiet,kingside-castle" }),
      move({ from: "e1", to: "c1", piece: "king", flags: "quiet,queenside-castle" }),
    ];
    expect(lameDuckRule.filterLegalMoves(statelessContext(), castles)).toEqual([]);
  });

  it("does not affect pawn promotion or en-passant because neither moves the king", () => {
    const unaffected = [
      move({
        from: "a7",
        to: "a8",
        piece: "pawn",
        promotion: "queen",
        flags: "quiet,promotion",
      }),
      move({
        from: "e5",
        to: "d6",
        piece: "pawn",
        captured: "pawn",
        flags: "capture,en-passant",
      }),
    ];
    expect(lameDuckRule.filterLegalMoves(statelessContext(), unaffected)).toEqual(unaffected);
  });

  it("returns an empty set when every ordinary legal move has a king primary mover", () => {
    const kingMove = move({ from: "e1", to: "e2", piece: "king" });
    expect(lameDuckRule.filterLegalMoves(statelessContext(), [kingMove])).toEqual([]);
  });

  it("does not define a start-of-turn loss", () => {
    expect(lameDuckRule.checkStartOfTurnLoss(statelessContext())).toBeNull();
  });
});

describe("Checkers", () => {
  it("preserves all ordinary legal moves when no capture is available", () => {
    const input = [
      move({ from: "e2", to: "e4", piece: "pawn" }),
      move({ from: "g1", to: "f3", piece: "knight" }),
    ];
    const output = checkersRule.filterLegalMoves(statelessContext(), input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  it("retains all and only captures when at least one capture is available", () => {
    const quiet = move({ from: "e2", to: "e4", piece: "pawn" });
    const captures = [
      move({ from: "c4", to: "d5", piece: "pawn", captured: "pawn" }),
      move({ from: "f3", to: "e5", piece: "knight", captured: "bishop" }),
    ];
    expect(checkersRule.filterLegalMoves(statelessContext(), [quiet, ...captures]))
      .toEqual(captures);
  });

  it("recognizes en-passant and capturing promotion as captures", () => {
    const quiet = move({ from: "a2", to: "a3", piece: "pawn" });
    const enPassant = move({
      from: "e5",
      to: "d6",
      piece: "pawn",
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const promotionCapture = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(checkersRule.filterLegalMoves(statelessContext(), [
      quiet,
      enPassant,
      promotionCapture,
    ])).toEqual([enPassant, promotionCapture]);
  });

  it("permits castling and quiet promotion when no capture exists", () => {
    const quietMoves = [
      move({ from: "e1", to: "g1", piece: "king", flags: "quiet,kingside-castle" }),
      move({
        from: "a7",
        to: "a8",
        piece: "pawn",
        promotion: "queen",
        flags: "quiet,promotion",
      }),
    ];
    expect(checkersRule.filterLegalMoves(statelessContext(), quietMoves)).toEqual(quietMoves);
  });

  it("does not invent a capture or loss when the ordinary move set is empty", () => {
    expect(checkersRule.filterLegalMoves(statelessContext(), [])).toEqual([]);
    expect(checkersRule.checkStartOfTurnLoss(statelessContext())).toBeNull();
  });
});

describe("Truant", () => {
  it("permits every move before the affected player has moved", () => {
    const input = [move({ from: "g1", to: "f3", piece: "knight" })];
    expect(truantRule.filterLegalMoves(truantContext(null), input)).toEqual(input);
  });

  it("forbids only the same physical primary mover on the next player turn", () => {
    const sameKnight = move({ from: "f3", to: "g5", piece: "knight" });
    const otherKnight = move({ from: "b1", to: "c3", piece: "knight" });
    expect(truantRule.filterLegalMoves(truantContext("f3"), [sameKnight, otherKnight]))
      .toEqual([otherKnight]);
  });

  it("tracks a promoted pawn by destination and records only the king for castling", () => {
    const promotion = move({
      from: "a7",
      to: "a8",
      piece: "pawn",
      promotion: "queen",
      flags: "quiet,promotion",
    });
    const transition: RuleTransitionContext<TruantState, NoParameters> = {
      ...truantContext("a7"),
      positionAfterMove: { ...position, ply: 1 },
    };
    const promotedState = truantRule.applyMove(transition, promotion);
    expect(promotedState.previousMoverDestination).toBe("a8");
    expect(truantRule.filterLegalMoves(
      truantContext(promotedState.previousMoverDestination),
      [move({ from: "a8", to: "a7", piece: "queen" })],
    )).toEqual([]);

    const castleState = truantRule.applyMove(
      { ...transition, state: promotedState },
      move({ from: "e1", to: "g1", piece: "king", flags: "quiet,kingside-castle" }),
    );
    expect(castleState.previousMoverDestination).toBe("g1");
  });

  it("tracks an en-passant pawn by its landing square", () => {
    const enPassant = move({
      from: "e5",
      to: "d6",
      piece: "pawn",
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const transition: RuleTransitionContext<TruantState, NoParameters> = {
      ...truantContext("e5"),
      positionAfterMove: { ...position, ply: 1 },
    };
    const state = truantRule.applyMove(transition, enPassant);
    expect(state.previousMoverDestination).toBe("d6");
    expect(truantRule.filterLegalMoves(
      truantContext(state.previousMoverDestination),
      [move({ from: "d6", to: "d7", piece: "pawn" })],
    )).toEqual([]);
  });

  it("returns an empty set for a forced repeated mover without defining its own loss", () => {
    const repeated = move({ from: "f3", to: "g5", piece: "knight" });
    expect(truantRule.filterLegalMoves(truantContext("f3"), [repeated])).toEqual([]);
    expect(truantRule.checkStartOfTurnLoss(truantContext("f3"))).toBeNull();
  });
});

describe("Spice of Life", () => {
  it("forbids all movers of the previous primary piece type", () => {
    const knightMoves = [
      move({ from: "f3", to: "g5", piece: "knight" }),
      move({ from: "b1", to: "c3", piece: "knight" }),
    ];
    const pawnMove = move({ from: "e2", to: "e4", piece: "pawn" });
    expect(spiceOfLifeRule.filterLegalMoves(spiceContext("knight"), [
      ...knightMoves,
      pawnMove,
    ])).toEqual([pawnMove]);
  });

  it("classifies promotion by the pre-move pawn type", () => {
    const promotion = move({
      from: "a7",
      to: "a8",
      piece: "pawn",
      promotion: "queen",
      flags: "quiet,promotion",
    });
    const transition: RuleTransitionContext<SpiceOfLifeState, NoParameters> = {
      ...spiceContext(null),
      positionAfterMove: { ...position, ply: 1 },
    };
    const state = spiceOfLifeRule.applyMove(transition, promotion);
    expect(state.previousMoverType).toBe("pawn");
    expect(spiceOfLifeRule.filterLegalMoves(
      spiceContext(state.previousMoverType),
      [
        move({ from: "a8", to: "b8", piece: "queen" }),
        move({ from: "h2", to: "h3", piece: "pawn" }),
      ],
    )).toEqual([move({ from: "a8", to: "b8", piece: "queen" })]);
  });

  it("classifies castling as a king move, not also a rook move", () => {
    const castle = move({
      from: "e1",
      to: "g1",
      piece: "king",
      flags: "quiet,kingside-castle",
    });
    const transition: RuleTransitionContext<SpiceOfLifeState, NoParameters> = {
      ...spiceContext(null),
      positionAfterMove: { ...position, ply: 1 },
    };
    expect(spiceOfLifeRule.applyMove(transition, castle).previousMoverType).toBe("king");
  });

  it("classifies en-passant as a pawn move", () => {
    const enPassant = move({
      from: "e5",
      to: "d6",
      piece: "pawn",
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const transition: RuleTransitionContext<SpiceOfLifeState, NoParameters> = {
      ...spiceContext("knight"),
      positionAfterMove: { ...position, ply: 1 },
    };
    const state = spiceOfLifeRule.applyMove(transition, enPassant);
    expect(state.previousMoverType).toBe("pawn");
  });

  it("returns an empty set for a forced repeated type without defining its own loss", () => {
    const pawnMove = move({ from: "e2", to: "e4", piece: "pawn" });
    expect(spiceOfLifeRule.filterLegalMoves(spiceContext("pawn"), [pawnMove])).toEqual([]);
    expect(spiceOfLifeRule.checkStartOfTurnLoss(spiceContext("pawn"))).toBeNull();
  });
});
