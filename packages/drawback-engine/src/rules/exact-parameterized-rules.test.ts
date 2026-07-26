import type { PlayerColor, RandomSource } from "@drawbackengine/shared";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  PromotionPiece,
  RuleMoveContext,
} from "../types.js";
import {
  activeVolcanoRule,
  comfortZoneRule,
  crenellationsRule,
  theocracyRule,
  type CaptureParityParameters,
  type SquareColorParameters,
} from "./exact-parameterized-rules.js";
import type {
  HiddenSquareParameters,
  ParameterizedRuleState,
} from "./parameterized-factories.js";

interface MoveInput {
  readonly from: string;
  readonly to: string;
  readonly color?: PlayerColor;
  readonly piece: PieceType;
  readonly captured?: PieceType;
  readonly promotion?: PromotionPiece;
  readonly flags?: string;
}

function move(input: MoveInput): ChessMove {
  return {
    from: input.from,
    to: input.to,
    color: input.color ?? "white",
    piece: input.piece,
    ...(input.captured === undefined ? {} : { captured: input.captured }),
    ...(input.promotion === undefined ? {} : { promotion: input.promotion }),
    san: `${input.from}-${input.to}`,
    flags: input.flags ?? (input.captured === undefined ? "quiet" : "capture"),
  };
}

function context<Parameters>(
  parameters: Parameters,
  fullmove = 1,
): RuleMoveContext<ParameterizedRuleState, Parameters> {
  return {
    color: "white",
    parameters,
    state: { movesApplied: fullmove - 1 },
    position: {
      fen: `8/8/8/8/8/8/8/8 w - - 0 ${String(fullmove)}`,
      turn: "white",
      ply: (fullmove - 1) * 2,
      history: [],
    },
  };
}

class ScriptedRandom implements RandomSource {
  readonly #values: readonly number[];
  #index = 0;

  public constructor(values: readonly number[]) {
    this.#values = values;
  }

  public next(): number {
    return 0;
  }

  public integer(maxExclusive: number): number {
    const value = this.#values[this.#index];
    this.#index += 1;
    if (value === undefined || value < 0 || value >= maxExclusive) {
      throw new RangeError("scripted random value is unavailable or out of range");
    }
    return value;
  }
}

describe("exact parameter generation", () => {
  it("deterministically generates both color and parity variants", () => {
    expect(crenellationsRule.generateParameters(new ScriptedRandom([0])))
      .toEqual({ squareColor: "light" });
    expect(crenellationsRule.generateParameters(new ScriptedRandom([1])))
      .toEqual({ squareColor: "dark" });
    expect(theocracyRule.generateParameters(new ScriptedRandom([0])))
      .toEqual({ captureParity: "odd" });
    expect(theocracyRule.generateParameters(new ScriptedRandom([1])))
      .toEqual({ captureParity: "even" });
  });

  it("deterministically maps RNG values to the observed middle-eight domain", () => {
    expect(activeVolcanoRule.generateParameters(new ScriptedRandom([0])))
      .toEqual({ square: "c4" });
    expect(activeVolcanoRule.generateParameters(new ScriptedRandom([7])))
      .toEqual({ square: "f5" });
    expect(comfortZoneRule.generateParameters(new ScriptedRandom([5])))
      .toEqual({ square: "d5" });
  });
});

describe("Crenellations", () => {
  const darkPawn = move({ from: "e2", to: "e3", piece: "pawn" });
  const lightPawn = move({ from: "e2", to: "e4", piece: "pawn" });
  const knight = move({ from: "g1", to: "f3", piece: "knight" });

  it("supports both hidden colors and never restricts non-pawns", () => {
    const moves = [lightPawn, darkPawn, knight];
    expect(crenellationsRule.filterLegalMoves(
      context<SquareColorParameters>({ squareColor: "light" }),
      moves,
    )).toEqual([lightPawn, knight]);
    expect(crenellationsRule.filterLegalMoves(
      context<SquareColorParameters>({ squareColor: "dark" }),
      moves,
    )).toEqual([darkPawn, knight]);
    expect(moves).toEqual([lightPawn, darkPawn, knight]);
  });

  it("uses the landing color for captures, en-passant, and promotions", () => {
    const capture = move({
      from: "e4",
      to: "d5",
      piece: "pawn",
      captured: "knight",
    });
    const enPassant = move({
      from: "e5",
      to: "d6",
      piece: "pawn",
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const promotion = move({
      from: "g7",
      to: "g8",
      piece: "pawn",
      promotion: "queen",
    });
    const castling = move({
      from: "e1",
      to: "g1",
      piece: "king",
      flags: "castle",
    });
    expect(crenellationsRule.filterLegalMoves(
      context<SquareColorParameters>({ squareColor: "light" }),
      [capture, enPassant, promotion, castling],
    )).toEqual([capture, promotion, castling]);
    expect(crenellationsRule.filterLegalMoves(
      context<SquareColorParameters>({ squareColor: "dark" }),
      [capture, enPassant, promotion, castling],
    )).toEqual([enPassant, castling]);
  });
});

describe("Theocracy", () => {
  const bishopCapture = move({
    from: "c4",
    to: "f7",
    piece: "bishop",
    captured: "pawn",
  });
  const rookCapture = move({
    from: "a1",
    to: "a7",
    piece: "rook",
    captured: "pawn",
  });
  const quiet = move({ from: "g1", to: "f3", piece: "knight" });

  it("activates each hidden parity only on matching fullmoves", () => {
    const moves = [bishopCapture, rookCapture, quiet];
    expect(theocracyRule.filterLegalMoves(
      context<CaptureParityParameters>({ captureParity: "odd" }, 1),
      moves,
    )).toEqual([bishopCapture, quiet]);
    const noTrigger = theocracyRule.filterLegalMoves(
      context<CaptureParityParameters>({ captureParity: "odd" }, 2),
      moves,
    );
    expect(noTrigger).toEqual(moves);
    expect(noTrigger).not.toBe(moves);
    expect(theocracyRule.filterLegalMoves(
      context<CaptureParityParameters>({ captureParity: "even" }, 2),
      moves,
    )).toEqual([bishopCapture, quiet]);
    expect(moves).toEqual([bishopCapture, rookCapture, quiet]);
  });

  it("classifies en-passant and capturing promotions by the original mover", () => {
    const enPassant = move({
      from: "e5",
      to: "d6",
      piece: "pawn",
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const capturingPromotion = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "bishop",
    });
    const castling = move({
      from: "e1",
      to: "g1",
      piece: "king",
      flags: "castle",
    });
    expect(theocracyRule.filterLegalMoves(
      context<CaptureParityParameters>({ captureParity: "odd" }, 1),
      [bishopCapture, enPassant, capturingPromotion, castling],
    )).toEqual([bishopCapture, castling]);
  });
});

describe("Active Volcano", () => {
  it("forbids the hidden square and its orthogonal neighbors, not diagonals", () => {
    const center = move({ from: "a1", to: "d4", piece: "knight" });
    const north = move({ from: "a1", to: "d5", piece: "knight" });
    const east = move({ from: "a1", to: "e4", piece: "knight" });
    const diagonal = move({ from: "a1", to: "e5", piece: "knight" });
    const far = move({ from: "a1", to: "d6", piece: "rook" });
    const moves = [center, north, east, diagonal, far];
    expect(activeVolcanoRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "d4" }),
      moves,
    )).toEqual([diagonal, far]);
    expect(moves).toEqual([center, north, east, diagonal, far]);
  });

  it("permits passing through the zone and applies only to primary destinations", () => {
    const sliderThrough = move({ from: "a4", to: "h4", piece: "rook" });
    const enPassantBlocked = move({
      from: "e5",
      to: "d6",
      piece: "pawn",
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const promotionBlocked = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "queen",
    });
    const castlingBlocked = move({
      from: "e1",
      to: "g1",
      piece: "king",
      flags: "castle",
    });
    expect(activeVolcanoRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "d5" }),
      [sliderThrough, enPassantBlocked],
    )).toEqual([sliderThrough]);
    expect(activeVolcanoRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "h7" }),
      [promotionBlocked, castlingBlocked],
    )).toEqual([castlingBlocked]);
    expect(activeVolcanoRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "f1" }),
      [castlingBlocked],
    )).toEqual([]);
  });

  it("clips the forbidden neighborhood at a board corner", () => {
    const hidden = move({ from: "h8", to: "a1", piece: "bishop" });
    const adjacent = move({ from: "h8", to: "a2", piece: "bishop" });
    const diagonal = move({ from: "h8", to: "b2", piece: "bishop" });
    expect(activeVolcanoRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "a1" }),
      [hidden, adjacent, diagonal],
    )).toEqual([diagonal]);
  });
});

describe("Comfort Zone", () => {
  it("returns an immutable clone when the hidden square cannot be reached", () => {
    const first = move({ from: "e2", to: "e4", piece: "pawn" });
    const second = move({ from: "g1", to: "f3", piece: "knight" });
    const moves = [first, second];
    const result = comfortZoneRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "d5" }),
      moves,
    );
    expect(result).toEqual(moves);
    expect(result).not.toBe(moves);
    expect(moves).toEqual([first, second]);
  });

  it("forces every move to the hidden square, including promotion choices", () => {
    const queenPromotion = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "queen",
    });
    const knightPromotion = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "knight",
    });
    const other = move({ from: "g7", to: "g8", piece: "pawn", promotion: "queen" });
    expect(comfortZoneRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "h8" }),
      [queenPromotion, knightPromotion, other],
    )).toEqual([queenPromotion, knightPromotion]);
  });

  it("forces captures, en-passant, or castling by their primary destination", () => {
    const capture = move({
      from: "c4",
      to: "d5",
      piece: "bishop",
      captured: "pawn",
    });
    const enPassant = move({
      from: "e5",
      to: "d6",
      piece: "pawn",
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const castling = move({
      from: "e1",
      to: "g1",
      piece: "king",
      flags: "castle",
    });
    const quiet = move({ from: "a2", to: "a3", piece: "pawn" });
    expect(comfortZoneRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "d5" }),
      [capture, enPassant, castling, quiet],
    )).toEqual([capture]);
    expect(comfortZoneRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "d6" }),
      [capture, enPassant, castling, quiet],
    )).toEqual([enPassant]);
    expect(comfortZoneRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "g1" }),
      [capture, enPassant, castling, quiet],
    )).toEqual([castling]);
  });
});
