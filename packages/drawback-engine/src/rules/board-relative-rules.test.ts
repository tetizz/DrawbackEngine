import type { PlayerColor } from "@drawbackengine/shared";
import { describe, expect, it } from "vitest";
import type { ChessMove, PositionView } from "../types.js";
import {
  cheerleadersRule,
  leadingTheChargeRule,
  nobleSteedRule,
  packMentalityRule,
  peonsFirstRule,
  powerCellsRule,
  royalBerthRule,
  scoutingAheadRule,
  separationAnxietyRule,
  separationOfChurchAndStateRule,
  siblingRivalryRule,
  socialDistancingRule,
  spreadOutRule,
  torchlightRule,
} from "./board-relative-rules.js";
import type { NoParameters, StatelessRuleState } from "./common.js";

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
  const color = options.color ?? "white";
  return {
    from,
    to,
    piece,
    color,
    san: `${from}${to}${options.promotion ?? ""}`,
    flags: options.flags ??
      (options.captured === undefined ? "quiet" : "capture"),
    ...(options.captured === undefined ? {} : { captured: options.captured }),
    ...(options.promotion === undefined ? {} : { promotion: options.promotion }),
  };
}

function position(fen: string, color: PlayerColor): PositionView {
  return {
    fen,
    turn: color,
    ply: 0,
    history: [],
  };
}

function context(fen: string, color: PlayerColor = "white") {
  return {
    color,
    parameters: {} as NoParameters,
    state: { movesApplied: 0 } as StatelessRuleState,
    position: position(fen, color),
  };
}

function allowed(
  rule: typeof cheerleadersRule,
  fen: string,
  moves: readonly ChessMove[],
  color: PlayerColor = "white",
): readonly ChessMove[] {
  return rule.filterLegalMoves(context(fen, color), moves);
}

describe("board-relative rules", () => {
  it("Cheerleaders restricts only non-pawn captures without an adjacent own pawn", () => {
    const fen = "4k3/8/8/8/3p3p/2B3B1/1P6/4K3 w - - 0 1";
    const adjacentCapture = move("c3", "d4", "bishop", { captured: "pawn" });
    const isolatedCapture = move("g3", "h4", "bishop", { captured: "pawn" });
    const isolatedQuiet = move("g3", "f4", "bishop");
    const pawnCapture = move("b2", "c3", "pawn", { captured: "knight" });

    expect(allowed(
      cheerleadersRule,
      fen,
      [adjacentCapture, isolatedCapture, isolatedQuiet, pawnCapture],
    )).toEqual([adjacentCapture, isolatedQuiet, pawnCapture]);
  });

  it("Cheerleaders does not count an adjacent enemy pawn", () => {
    const capture = move("c3", "d4", "bishop", { captured: "rook" });
    expect(allowed(
      cheerleadersRule,
      "4k3/8/8/8/1p1r4/2B5/8/4K3 w - - 0 1",
      [capture],
    )).toEqual([]);
  });

  it("Noble Steed permits knights and non-knights adjacent to an own knight", () => {
    const fen = "4k3/8/8/8/8/8/1N6/R3K2R w - - 0 1";
    const supportedRook = move("a1", "a2", "rook");
    const isolatedRook = move("h1", "h2", "rook");
    const knight = move("b2", "c4", "knight");

    expect(allowed(
      nobleSteedRule,
      fen,
      [supportedRook, isolatedRook, knight],
    )).toEqual([supportedRook, knight]);
  });

  it("Noble Steed applies symmetrically to Black", () => {
    const fen = "r3k2r/1n6/8/8/8/8/8/4K3 b - - 0 1";
    const supportedRook = move("a8", "a7", "rook", { color: "black" });
    const isolatedRook = move("h8", "h7", "rook", { color: "black" });
    expect(allowed(
      nobleSteedRule,
      fen,
      [supportedRook, isolatedRook],
      "black",
    )).toEqual([supportedRook]);
  });

  it("Pack Mentality excludes the moving piece's vacated origin", () => {
    const fen = "4k3/8/8/8/P7/2R5/8/4K3 w - - 0 1";
    const grouped = move("c3", "b3", "rook");
    const isolated = move("c3", "e3", "rook");
    const originOnly = move("c3", "c4", "rook");

    expect(allowed(
      packMentalityRule,
      fen,
      [grouped, isolated, originOnly],
    )).toEqual([grouped]);
  });

  it("Pack Mentality permits either standard castling move", () => {
    const fen = "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1";
    const kingSide = move("e1", "g1", "king", {
      flags: "king-side-castle",
    });
    const queenSide = move("e1", "c1", "king", {
      flags: "queen-side-castle",
    });
    expect(allowed(packMentalityRule, fen, [kingSide, queenSide]))
      .toEqual([kingSide, queenSide]);
  });

  it("Separation Anxiety keeps an adjacent pawn near its own king", () => {
    const fen = "4k3/8/8/8/8/8/3PK1P1/8 w - - 0 1";
    const staysClose = move("d2", "d3", "pawn");
    const leaves = move("d2", "d4", "pawn");
    const unrelatedPawn = move("g2", "g4", "pawn");
    const kingMove = move("e2", "f2", "king");

    expect(allowed(
      separationAnxietyRule,
      fen,
      [staysClose, leaves, unrelatedPawn, kingMove],
    )).toEqual([staysClose, unrelatedPawn, kingMove]);
  });

  it("Separation Anxiety applies to captures, en-passant, and promotion endpoints", () => {
    const fen = "4k3/2P5/4K3/3pP3/8/8/8/8 w - d6 0 1";
    const enPassant = move("e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const promotion = move("c7", "c8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    expect(allowed(separationAnxietyRule, fen, [enPassant, promotion]))
      .toEqual([enPassant, promotion]);
  });

  it("Separation Anxiety rejects malformed positions without the own king", () => {
    expect(() => allowed(
      separationAnxietyRule,
      "4k3/8/8/8/8/8/3P4/8 w - - 0 1",
      [move("d2", "d3", "pawn")],
    )).toThrow("FEN does not contain a white king");
  });

  it("Separation of Church and State keeps bishops away from either king", () => {
    const fen = "8/8/8/4k3/8/2B5/8/4K3 w - - 0 1";
    const nearEnemyKing = move("c3", "d4", "bishop");
    const awayFromKings = move("c3", "b4", "bishop");
    expect(allowed(
      separationOfChurchAndStateRule,
      fen,
      [nearEnemyKing, awayFromKings],
    )).toEqual([awayFromKings]);
  });

  it("Separation of Church and State lets a king capture the adjacent bishop", () => {
    const fen = "4k3/8/8/8/8/3b4/4K3/8 w - - 0 1";
    const captureBishop = move("e2", "d3", "king", { captured: "bishop" });
    const approachBishop = move("e2", "e3", "king");
    expect(allowed(
      separationOfChurchAndStateRule,
      fen,
      [captureBishop, approachBishop],
    )).toEqual([captureBishop]);
  });

  it("Sibling Rivalry rejects adjacency only to an opposing matching type", () => {
    const fen = "4k3/8/4n3/8/8/2N5/8/4K3 w - - 0 1";
    const rivalAdjacent = move("c3", "d5", "knight");
    const noRival = move("c3", "b5", "knight");
    expect(allowed(siblingRivalryRule, fen, [rivalAdjacent, noRival]))
      .toEqual([noRival]);
  });

  it("Sibling Rivalry ignores a matching piece captured on the destination", () => {
    const fen = "4k3/8/8/3n4/8/2N5/8/4K3 w - - 0 1";
    const captureRival = move("c3", "d5", "knight", {
      captured: "knight",
    });
    expect(allowed(siblingRivalryRule, fen, [captureRival]))
      .toEqual([captureRival]);
  });

  it("Sibling Rivalry uses a promotion's resulting piece type", () => {
    const fen = "4k3/6Pr/8/8/8/8/8/4K3 w - - 0 1";
    const promoteRook = move("g7", "g8", "pawn", {
      promotion: "rook",
      flags: "promotion",
    });
    const promoteQueen = move("g7", "g8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    expect(allowed(siblingRivalryRule, fen, [promoteRook, promoteQueen]))
      .toEqual([promoteQueen]);
  });

  it("Sibling Rivalry removes an en-passant victim before checking adjacency", () => {
    const enPassant = move("e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    expect(allowed(
      siblingRivalryRule,
      "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
      [enPassant],
    )).toEqual([enPassant]);
  });

  it("Social Distancing rejects adjacent quiet moves but permits captures and en-passant", () => {
    const fen = "4k3/8/4p3/8/4p3/2N5/8/4K3 w - - 0 1";
    const adjacentQuiet = move("c3", "d5", "knight");
    const distantQuiet = move("c3", "b5", "knight");
    const capture = move("c3", "e4", "knight", { captured: "pawn" });
    const enPassant = move("d5", "e6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });

    expect(allowed(
      socialDistancingRule,
      fen,
      [adjacentQuiet, distantQuiet, capture, enPassant],
    )).toEqual([distantQuiet, capture, enPassant]);
  });

  it("Spread Out excludes the origin and ignores own pawns as neighbors", () => {
    const fen = "4k3/8/4B3/8/P7/2N5/8/4K3 w - - 0 1";
    const nextToNonPawn = move("c3", "d5", "knight");
    const nextToPawn = move("c3", "b5", "knight");
    expect(allowed(spreadOutRule, fen, [nextToNonPawn, nextToPawn]))
      .toEqual([nextToPawn]);
  });

  it("Spread Out forbids castling but treats promotions as pawn moves", () => {
    const fen = "4k3/6P1/8/8/8/8/8/R3K2R w KQ - 0 1";
    const castle = move("e1", "g1", "king", {
      flags: "king-side-castle",
    });
    const promotion = move("g7", "g8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    expect(allowed(spreadOutRule, fen, [castle, promotion]))
      .toEqual([promotion]);
  });

  it("Torchlight permits pawn moves and non-pawn moves lit at either endpoint", () => {
    const fen = "4k3/8/8/8/7R/8/1P4P1/R2RK3 w - - 0 1";
    const litAtOrigin = move("a1", "a3", "rook");
    const litAtDestination = move("h4", "h3", "rook");
    const unlit = move("d1", "d4", "rook");
    const pawn = move("b2", "b4", "pawn");
    expect(allowed(
      torchlightRule,
      fen,
      [litAtOrigin, litAtDestination, unlit, pawn],
    )).toEqual([litAtOrigin, litAtDestination, pawn]);
  });

  it("Royal Berth rejects a non-king destination adjacent to the own king", () => {
    const fen = "4k3/8/8/8/8/8/R7/4K3 w - - 0 1";
    const entersBerth = move("a2", "e2", "rook");
    const staysAway = move("a2", "a3", "rook");
    expect(allowed(royalBerthRule, fen, [entersBerth, staysAway]))
      .toEqual([staysAway]);
  });

  it("Royal Berth also prevents the king from moving next to an own piece", () => {
    const fen = "4k3/8/8/8/8/2B5/8/4K3 w - - 0 1";
    const entersBerth = move("e1", "d2", "king");
    const staysAway = move("e1", "f1", "king");
    expect(allowed(royalBerthRule, fen, [entersBerth, staysAway]))
      .toEqual([staysAway]);
  });

  it("Peons First blocks every primary mover directly behind an own pawn", () => {
    const fen = "4k3/8/8/8/4P3/2N1N3/8/4K3 w - - 0 1";
    const blocked = move("e3", "c4", "knight");
    const free = move("c3", "b5", "knight");
    expect(allowed(peonsFirstRule, fen, [blocked, free])).toEqual([free]);
  });

  it("Peons First mirrors the definition of behind for Black", () => {
    const fen = "4k3/8/2bb4/3p4/8/8/8/4K3 b - - 0 1";
    const blocked = move("d6", "e5", "bishop", { color: "black" });
    const free = move("c6", "b5", "bishop", { color: "black" });
    expect(allowed(peonsFirstRule, fen, [blocked, free], "black"))
      .toEqual([free]);
  });

  it("Power Cells uses own pawn count and Manhattan distance", () => {
    const fen = "4k3/8/8/8/8/8/PP6/R3K3 w - - 0 1";
    const distanceTwo = move("a1", "a3", "rook");
    const distanceThree = move("a1", "a4", "rook");
    const knightDistanceThree = move("b1", "c3", "knight");
    expect(allowed(
      powerCellsRule,
      fen,
      [distanceTwo, distanceThree, knightDistanceThree],
    )).toEqual([distanceTwo]);
  });

  it("Power Cells permits no positive-distance move when no own pawn remains", () => {
    expect(allowed(
      powerCellsRule,
      "4k3/8/8/8/8/8/8/R3K3 w - - 0 1",
      [move("a1", "a2", "rook"), move("e1", "f1", "king")],
    )).toEqual([]);
  });

  it("Leading the Charge uses the most advanced own knight as the frontier", () => {
    const fen = "4k3/8/8/3N4/8/6N1/2R5/4K3 w - - 0 1";
    const atFrontier = move("c2", "c5", "rook");
    const ahead = move("c2", "c6", "rook");
    const knightAhead = move("d5", "f6", "knight");
    expect(allowed(
      leadingTheChargeRule,
      fen,
      [atFrontier, ahead, knightAhead],
    )).toEqual([atFrontier, knightAhead]);
  });

  it("Leading the Charge mirrors advancement for Black and deactivates without knights", () => {
    const withKnight = "4k3/2r5/6n1/3n4/8/8/8/4K3 b - - 0 1";
    const atFrontier = move("c7", "c5", "rook", { color: "black" });
    const ahead = move("c7", "c4", "rook", { color: "black" });
    expect(allowed(
      leadingTheChargeRule,
      withKnight,
      [atFrontier, ahead],
      "black",
    )).toEqual([atFrontier]);
    expect(allowed(
      leadingTheChargeRule,
      "4k3/2r5/8/8/8/8/8/4K3 b - - 0 1",
      [ahead],
      "black",
    )).toEqual([ahead]);
  });

  it("Scouting Ahead uses the most advanced own pawn and never blocks pawns", () => {
    const fen = "4k3/8/8/3P4/8/6P1/2R5/4K3 w - - 0 1";
    const atFrontier = move("c2", "c5", "rook");
    const ahead = move("c2", "c6", "rook");
    const pawnAhead = move("d5", "d6", "pawn");
    expect(allowed(
      scoutingAheadRule,
      fen,
      [atFrontier, ahead, pawnAhead],
    )).toEqual([atFrontier, pawnAhead]);
  });

  it("Scouting Ahead mirrors advancement for Black and deactivates without pawns", () => {
    const withPawn = "4k3/2r5/6p1/3p4/8/8/8/4K3 b - - 0 1";
    const atFrontier = move("c7", "c5", "rook", { color: "black" });
    const ahead = move("c7", "c4", "rook", { color: "black" });
    expect(allowed(
      scoutingAheadRule,
      withPawn,
      [atFrontier, ahead],
      "black",
    )).toEqual([atFrontier]);
    expect(allowed(
      scoutingAheadRule,
      "4k3/2r5/8/8/8/8/8/4K3 b - - 0 1",
      [ahead],
      "black",
    )).toEqual([ahead]);
  });

  it("uses the logged king move for Torchlight and Peons First castling", () => {
    const kingSide = move("e1", "g1", "king", {
      flags: "king-side-castle",
    });
    const queenSide = move("e1", "c1", "king", {
      flags: "queen-side-castle",
    });
    expect(allowed(
      torchlightRule,
      "4k3/8/8/8/8/8/5P2/R3K3 w Q - 0 1",
      [queenSide],
    )).toEqual([queenSide]);
    expect(allowed(
      peonsFirstRule,
      "4k3/8/8/8/8/8/7P/4K2R w K - 0 1",
      [kingSide],
    )).toEqual([kingSide]);
  });

  it("never mutates the ordinary move array or its move objects", () => {
    const candidate = Object.freeze(move("c3", "b5", "knight"));
    const ordinary = Object.freeze([candidate]);
    const result = allowed(
      siblingRivalryRule,
      "4k3/8/8/8/8/2N5/8/4K3 w - - 0 1",
      ordinary,
    );
    expect(result).toEqual([candidate]);
    expect(result).not.toBe(ordinary);
    expect(ordinary).toEqual([candidate]);
  });
});
