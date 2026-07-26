import type { PlayerColor } from "@drawbackengine/shared";
import { describe, expect, it } from "vitest";
import type { ChessMove, DrawbackRule } from "../types.js";
import type { NoParameters, StatelessRuleState } from "./common.js";
import {
  crossingTheRubiconRule,
  geometricObservedRules,
  insideTheLinesRule,
  irresistibleRule,
  lethalAttractionRule,
  primaDonnaRule,
  thunderdomeRule,
  trueLoveRule,
} from "./geometric-observed-rules.js";

interface MoveOptions {
  readonly color?: PlayerColor;
  readonly captured?: ChessMove["captured"];
  readonly promotion?: ChessMove["promotion"];
  readonly flags?: string;
}

function move(
  from: string,
  to: string,
  piece: ChessMove["piece"],
  options: MoveOptions = {},
): ChessMove {
  return {
    from,
    to,
    piece,
    color: options.color ?? "white",
    san: `${from}-${to}`,
    flags: options.flags ??
      (options.captured === undefined ? "quiet" : "capture"),
    ...(options.captured === undefined ? {} : { captured: options.captured }),
    ...(options.promotion === undefined ? {} : { promotion: options.promotion }),
  };
}

function allowed(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
  fen: string,
  candidates: readonly ChessMove[],
  color: PlayerColor = "white",
): readonly ChessMove[] {
  return rule.filterLegalMoves(
    {
      color,
      parameters: {},
      state: { movesApplied: 0 },
      position: { fen, turn: color, ply: 0, history: [] },
    },
    candidates,
  );
}

describe("geometric observed rules", () => {
  it("has unique metadata, exact status labels, and immutable filtering", () => {
    expect(geometricObservedRules).toHaveLength(7);
    expect(new Set(geometricObservedRules.map(({ id }) => id)).size).toBe(7);
    expect(irresistibleRule.verification).toBe("partial");
    expect(geometricObservedRules.filter(({ id }) => id !== "irresistible")
      .every(({ verification }) => verification === "implemented-unverified"))
      .toBe(true);
    const candidate = Object.freeze(move("a2", "a3", "pawn"));
    const ordinary = Object.freeze([candidate]);
    const result = crossingTheRubiconRule.filterLegalMoves(
      {
        color: "white",
        parameters: {},
        state: { movesApplied: 0 },
        position: {
          fen: "4k3/8/8/8/8/8/P7/4K3 w - - 0 1",
          turn: "white",
          ply: 0,
          history: [],
        },
      },
      ordinary,
    );
    expect(result).not.toBe(ordinary);
    expect(ordinary).toEqual([candidate]);
  });

  it("Crossing the Rubicon blocks only returns from the opponent half", () => {
    const fen = "4k3/8/3R4/8/8/8/8/4K3 w - - 0 1";
    const returnHome = move("d6", "d4", "rook");
    const remainAcross = move("d6", "d5", "rook");
    const firstCrossing = move("d4", "d5", "rook");
    expect(allowed(
      crossingTheRubiconRule,
      fen,
      [returnHome, remainAcross, firstCrossing],
    )).toEqual([remainAcross, firstCrossing]);
  });

  it("Crossing the Rubicon mirrors the halves for Black", () => {
    const fen = "4k3/8/8/8/8/3r4/8/4K3 b - - 0 1";
    const returnHome = move("d3", "d5", "rook", { color: "black" });
    const remainAcross = move("d3", "d4", "rook", { color: "black" });
    expect(allowed(
      crossingTheRubiconRule,
      fen,
      [returnHome, remainAcross],
      "black",
    )).toEqual([remainAcross]);
  });

  it("True Love constrains king and queen destinations but not other movers", () => {
    const fen = "4k3/8/8/8/8/8/8/3QK1N1 w - - 0 1";
    const kingNear = move("e1", "e2", "king");
    const kingFar = move("e1", "f2", "king");
    const queenNear = move("d1", "d2", "queen");
    const queenFar = move("d1", "d4", "queen");
    const knight = move("g1", "f3", "knight");
    expect(allowed(
      trueLoveRule,
      fen,
      [kingNear, kingFar, queenNear, queenFar, knight],
    )).toEqual([kingNear, queenNear, knight]);
  });

  it("True Love freezes the king without a queen but allows pawn promotion", () => {
    const fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const king = move("e1", "e2", "king");
    const promotion = move("a7", "a8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    expect(allowed(trueLoveRule, fen, [king, promotion]))
      .toEqual([promotion]);
  });

  it("True Love accepts adjacency to any own queen", () => {
    const fen = "Q3k3/8/8/8/8/8/5Q2/4K3 w - - 0 1";
    const adjacentToSecondQueen = move("e1", "e2", "king");
    expect(allowed(trueLoveRule, fen, [adjacentToSecondQueen]))
      .toEqual([adjacentToSecondQueen]);
  });

  it("Lethal Attraction permits closer and equal distances but rejects farther", () => {
    const fen = "8/7k/8/8/3Q4/8/8/4K3 w - - 0 1";
    const closer = move("d4", "d6", "queen");
    const equal = move("d4", "c5", "queen");
    const farther = move("d4", "d2", "queen");
    expect(allowed(lethalAttractionRule, fen, [closer, equal, farther]))
      .toEqual([closer, equal]);
  });

  it("Lethal Attraction fails closed without an opponent king", () => {
    expect(() => allowed(
      lethalAttractionRule,
      "8/8/8/8/3R4/8/8/4K3 w - - 0 1",
      [move("d4", "d5", "rook")],
    )).toThrow("opponent king");
  });

  it("Thunderdome blocks departure while any other piece remains inside", () => {
    const mover = move("d4", "d2", "rook");
    expect(allowed(
      thunderdomeRule,
      "4k3/8/8/5N2/3R4/8/8/4K3 w - - 0 1",
      [mover],
    )).toEqual([]);
    expect(allowed(
      thunderdomeRule,
      "4k3/8/8/5n2/3R4/8/8/4K3 w - - 0 1",
      [mover],
    )).toEqual([]);
  });

  it("Thunderdome permits a sole occupant to leave and all pieces to enter", () => {
    const leave = move("d4", "d2", "rook");
    const enter = move("a4", "c4", "rook");
    expect(allowed(
      thunderdomeRule,
      "4k3/8/8/8/3R4/8/8/4K3 w - - 0 1",
      [leave],
    )).toEqual([leave]);
    expect(allowed(
      thunderdomeRule,
      "4k3/8/8/8/R7/8/8/4K3 w - - 0 1",
      [enter],
    )).toEqual([enter]);
  });

  it("Irresistible forces every newly adjacent destination", () => {
    const fen = "4k3/8/8/2N5/8/8/8/4K3 w - - 0 1";
    const forcingOne = move("c5", "d7", "knight");
    const forcingTwo = move("a7", "e7", "rook");
    const other = move("c5", "a4", "knight");
    expect(allowed(
      irresistibleRule,
      fen,
      [forcingOne, forcingTwo, other],
    )).toEqual([forcingOne, forcingTwo]);
  });

  it("Irresistible ignores pieces already adjacent and preserves synthetic king captures", () => {
    const fen = "4k3/8/8/2N5/8/8/8/4K3 w - - 0 1";
    const forcing = move("c5", "d7", "knight");
    const alreadyAdjacent = move("d7", "f7", "knight");
    const kingCapture = move("d7", "e8", "knight", {
      captured: "king",
    });
    expect(allowed(
      irresistibleRule,
      fen,
      [forcing, alreadyAdjacent, kingCapture],
    )).toEqual([forcing, kingCapture]);
  });

  it("Irresistible preserves every move when no new adjacency is possible", () => {
    const fen = "4k3/3N4/8/8/8/8/P7/4K3 w - - 0 1";
    const alreadyAdjacent = move("d7", "f7", "knight");
    const unrelated = move("a2", "a3", "pawn");
    expect(allowed(
      irresistibleRule,
      fen,
      [alreadyAdjacent, unrelated],
    )).toEqual([alreadyAdjacent, unrelated]);
  });

  it("Prima Donna rejects pawn captures that create a same-file pair", () => {
    const fen = "4k3/8/8/8/3P4/8/4P3/4K3 w - - 0 1";
    const createsPair = move("d4", "e5", "pawn", {
      captured: "pawn",
    });
    const advances = move("d4", "d5", "pawn");
    expect(allowed(primaDonnaRule, fen, [createsPair, advances]))
      .toEqual([advances]);
  });

  it("Prima Donna allows promotion because the pawn leaves the pawn set", () => {
    const fen = "4k3/4P3/8/8/8/8/4P3/4K3 w - - 0 1";
    const promotion = move("e7", "e8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    expect(allowed(primaDonnaRule, fen, [promotion])).toEqual([promotion]);
  });

  it("Prima Donna requires an already-invalid position to be repaired", () => {
    const fen = "4k3/8/8/4P3/4P3/8/8/R3K3 w - - 0 1";
    const nonPawn = move("a1", "a2", "rook");
    const repair = move("e5", "d6", "pawn", { captured: "pawn" });
    expect(allowed(primaDonnaRule, fen, [nonPawn, repair]))
      .toEqual([repair]);
  });

  it("Inside the Lines forbids entering the rim but permits rim-origin moves", () => {
    const fen = "4k3/8/8/8/8/8/RN6/4K3 w - - 0 1";
    const enter = move("b2", "a2", "knight");
    const inside = move("b2", "c4", "knight");
    const rimToRim = move("a2", "a3", "rook");
    const rimToInside = move("a2", "b2", "rook");
    expect(allowed(
      insideTheLinesRule,
      fen,
      [enter, inside, rimToRim, rimToInside],
    )).toEqual([inside, rimToRim, rimToInside]);
  });

  it("Inside the Lines applies to promotions and primary castling endpoints", () => {
    const fen = "4k3/1P6/8/8/8/8/8/R3K2R w KQ - 0 1";
    const promotion = move("b7", "b8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(allowed(insideTheLinesRule, fen, [promotion, castle]))
      .toEqual([castle]);
  });
});
