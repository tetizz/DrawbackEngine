import type { PlayerColor, RandomSource } from "@drawbackengine/shared";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  PromotionPiece,
  RuleMoveContext,
} from "../types.js";
import { gamblerRule } from "./gambler.js";
import { justPassingThroughRule } from "./just-passing-through.js";
import {
  hiddenPieceTypeForTurn,
  type HiddenPieceTypeParameters,
  type HiddenRankParameters,
  type HiddenSquareParameters,
  type ParameterizedRuleState,
} from "./parameterized-factories.js";
import { untitledDuckDrawbackRule } from "./untitled-duck-drawback.js";

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
  movesApplied = 0,
): RuleMoveContext<ParameterizedRuleState, Parameters> {
  return {
    color: "white",
    parameters,
    state: { movesApplied },
    position: {
      fen: "8/8/8/8/8/8/8/8 w - - 0 1",
      turn: "white",
      ply: movesApplied * 2,
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

describe("parameter generation", () => {
  it("maps deterministic RNG values to a square, rank, and piece-type seed", () => {
    expect(
      untitledDuckDrawbackRule.generateParameters(new ScriptedRandom([7, 0])),
    ).toEqual({ square: "h1" });
    expect(
      justPassingThroughRule.generateParameters(new ScriptedRandom([5])),
    ).toEqual({ rank: 6 });
    expect(gamblerRule.generateParameters(new ScriptedRandom([0xdeadbeef])))
      .toEqual({ seed: 0xdeadbeef });
  });

  it("marks all three evidence-backed implementations unverified", () => {
    expect([
      untitledDuckDrawbackRule.verification,
      justPassingThroughRule.verification,
      gamblerRule.verification,
    ]).toEqual([
      "implemented-unverified",
      "implemented-unverified",
      "implemented-unverified",
    ]);
  });
});

describe("Untitled Duck Drawback", () => {
  it("forbids landing on the hidden square while preserving the input", () => {
    const blocked = move({ from: "c3", to: "d5", piece: "knight" });
    const allowed = move({ from: "c3", to: "b5", piece: "knight" });
    const input = [blocked, allowed];
    const result = untitledDuckDrawbackRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "d5" }),
      input,
    );
    expect(result).toEqual([allowed]);
    expect(result).not.toBe(input);
    expect(input).toEqual([blocked, allowed]);
  });

  it("forbids a sliding piece or double-step pawn from passing through the square", () => {
    const rookThrough = move({ from: "a1", to: "a8", piece: "rook" });
    const bishopThrough = move({ from: "c1", to: "h6", piece: "bishop" });
    const pawnThrough = move({ from: "e2", to: "e4", piece: "pawn" });
    const knightOver = move({ from: "g1", to: "e2", piece: "knight" });
    expect(untitledDuckDrawbackRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "e3" }),
      [rookThrough, bishopThrough, pawnThrough, knightOver],
    )).toEqual([rookThrough, knightOver]);
    expect(untitledDuckDrawbackRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "a4" }),
      [rookThrough],
    )).toEqual([]);
  });

  it("blocks castling through the square but checks only the king's primary path", () => {
    const castle = move({
      from: "e1",
      to: "g1",
      piece: "king",
      flags: "quiet,kingside-castle",
    });
    expect(untitledDuckDrawbackRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "f1" }),
      [castle],
    )).toEqual([]);
    expect(untitledDuckDrawbackRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "h1" }),
      [castle],
    )).toEqual([castle]);
  });

  it("forbids capturing promotion onto the square and allows moving away from it", () => {
    const promotion = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    const away = move({ from: "h8", to: "g8", piece: "rook" });
    expect(untitledDuckDrawbackRule.filterLegalMoves(
      context<HiddenSquareParameters>({ square: "h8" }),
      [promotion, away],
    )).toEqual([away]);
  });
});

describe("Just Passing Through", () => {
  it("forbids captures on the hidden rank but permits quiet moves to it", () => {
    const capture = move({
      from: "c4",
      to: "d5",
      piece: "bishop",
      captured: "pawn",
    });
    const quiet = move({ from: "c4", to: "d5", piece: "bishop" });
    expect(justPassingThroughRule.filterLegalMoves(
      context<HiddenRankParameters>({ rank: 5 }),
      [capture, quiet],
    )).toEqual([quiet]);
  });

  it("forbids en-passant and capturing promotion on the rank", () => {
    const enPassant = move({
      from: "e5",
      to: "d6",
      piece: "pawn",
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const promotion = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(justPassingThroughRule.filterLegalMoves(
      context<HiddenRankParameters>({ rank: 6 }),
      [enPassant, promotion],
    )).toEqual([promotion]);
    expect(justPassingThroughRule.filterLegalMoves(
      context<HiddenRankParameters>({ rank: 8 }),
      [promotion],
    )).toEqual([]);
  });

  it("does not affect non-capturing castling", () => {
    const castle = move({
      from: "e1",
      to: "c1",
      piece: "king",
      flags: "quiet,queenside-castle",
    });
    expect(justPassingThroughRule.filterLegalMoves(
      context<HiddenRankParameters>({ rank: 1 }),
      [castle],
    )).toEqual([castle]);
  });
});

describe("Gambler", () => {
  const parameters: HiddenPieceTypeParameters = { seed: 123456789 };
  const pieceTypes: readonly PieceType[] = [
    "pawn",
    "knight",
    "bishop",
    "rook",
    "queen",
    "king",
  ];

  it("forbids every mover of the selected hidden type and no other type", () => {
    const selected = hiddenPieceTypeForTurn(parameters, { movesApplied: 0 });
    const moves = pieceTypes.map((piece, index) =>
      move({
        from: `${String.fromCharCode(97 + index)}2`,
        to: `${String.fromCharCode(97 + index)}3`,
        piece,
      }),
    );
    expect(gamblerRule.filterLegalMoves(context(parameters), moves).map(({ piece }) => piece))
      .toEqual(pieceTypes.filter((piece) => piece !== selected));
  });

  it("derives a deterministic per-turn sequence that can repeat naturally", () => {
    const first = Array.from({ length: 16 }, (_, movesApplied) =>
      hiddenPieceTypeForTurn(parameters, { movesApplied }),
    );
    const second = Array.from({ length: 16 }, (_, movesApplied) =>
      hiddenPieceTypeForTurn(parameters, { movesApplied }),
    );
    expect(first).toEqual(second);
    expect(new Set(first).size).toBeGreaterThan(1);
  });

  it("classifies promotion by the pawn mover and castling by the king mover", () => {
    const promotion = move({
      from: "a7",
      to: "a8",
      piece: "pawn",
      promotion: "knight",
      flags: "quiet,promotion",
    });
    const castle = move({
      from: "e1",
      to: "g1",
      piece: "king",
      flags: "quiet,kingside-castle",
    });
    const pawnTurn = Array.from({ length: 100 }, (_, movesApplied) => movesApplied)
      .find(
        (movesApplied) =>
          hiddenPieceTypeForTurn(parameters, { movesApplied }) === "pawn",
      );
    const kingTurn = Array.from({ length: 100 }, (_, movesApplied) => movesApplied)
      .find(
        (movesApplied) =>
          hiddenPieceTypeForTurn(parameters, { movesApplied }) === "king",
      );
    expect(pawnTurn).toBeDefined();
    expect(kingTurn).toBeDefined();
    expect(gamblerRule.filterLegalMoves(context(parameters, pawnTurn), [promotion]))
      .toEqual([]);
    expect(gamblerRule.filterLegalMoves(context(parameters, kingTurn), [castle]))
      .toEqual([]);
  });
});
