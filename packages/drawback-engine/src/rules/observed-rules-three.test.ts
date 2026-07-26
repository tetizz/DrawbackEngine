import { readFileSync } from "node:fs";
import type { PlayerColor } from "@drawbackengine/shared";
import { describe, expect, it } from "vitest";
import type { ChessMove, PositionView } from "../types.js";
import type { NoParameters, StatelessRuleState } from "./common.js";
import {
  bodySnatcherRule,
  bongcloudRule,
  botezGambitRule,
  castleDoctrineRule,
  eatYourVegetablesRule,
  edgelordRule,
  eisoptrophobiaRule,
  gloomstalkerRule,
  horseEatsFirstRule,
  luckyRule,
  messyDivorceRule,
  myKingdomForAHorseRule,
  noblesseObligeRule,
  observedRulesThree,
  octomomRule,
  pawnBattleRule,
} from "./observed-rules-three.js";

function move(
  from: string,
  to: string,
  piece: ChessMove["piece"],
  captured?: ChessMove["captured"],
  color: PlayerColor = "white",
): ChessMove {
  return {
    from,
    to,
    piece,
    color,
    san: `${from}${to}`,
    flags: captured === undefined ? "quiet" : "capture",
    ...(captured === undefined ? {} : { captured }),
  };
}

function position(
  fen: string,
  color: PlayerColor = "white",
  history: readonly ChessMove[] = [],
): PositionView {
  return {
    fen,
    turn: color,
    ply: history.length,
    history,
  };
}

function context(
  fen: string,
  color: PlayerColor = "white",
  history: readonly ChessMove[] = [],
) {
  return {
    color,
    parameters: {} as NoParameters,
    state: { movesApplied: 0 } as StatelessRuleState,
    position: position(fen, color, history),
  };
}

const BASE_FEN = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";

describe("third observed rule batch", () => {
  it("registers fifteen unique executable rules", () => {
    expect(observedRulesThree).toHaveLength(15);
    expect(new Set(observedRulesThree.map(({ id }) => id)).size).toBe(15);
    expect(observedRulesThree.every(
      ({ verification }) => verification === "implemented-unverified",
    )).toBe(true);
  });

  it("matches the machine-readable catalog fragment", () => {
    const catalog = JSON.parse(readFileSync(
      new URL(
        "../../../../data/catalog/observed-rules-three.json",
        import.meta.url,
      ),
      "utf8",
    )) as readonly {
      readonly id: string;
      readonly implementationStatus: string;
    }[];
    expect(catalog.map(({ id }) => id).sort()).toEqual(
      observedRulesThree.map(({ id }) => id).sort(),
    );
    expect(catalog.every(
      ({ implementationStatus }) =>
        implementationStatus === "implemented-unverified",
    )).toBe(true);
  });

  it("Lucky leaves an immutable copy of all ordinary legal moves", () => {
    const moves = [move("e2", "e4", "pawn"), move("g1", "f3", "knight")];
    const allowed = luckyRule.filterLegalMoves(context(BASE_FEN), moves);
    expect(allowed).toEqual(moves);
    expect(allowed).not.toBe(moves);
  });

  it("Eisoptrophobia rejects only same-type captures", () => {
    const moves = [
      move("c3", "d5", "knight", "knight"),
      move("c3", "b5", "knight", "bishop"),
      move("c3", "a4", "knight"),
    ];
    expect(eisoptrophobiaRule.filterLegalMoves(context(BASE_FEN), moves))
      .toEqual([moves[1], moves[2]]);
  });

  it("Gloomstalker permits captures only from dark squares", () => {
    const moves = [
      move("c3", "d5", "knight", "pawn"),
      move("b3", "d4", "knight", "pawn"),
      move("b3", "a5", "knight"),
    ];
    expect(gloomstalkerRule.filterLegalMoves(context(BASE_FEN), moves))
      .toEqual([moves[0], moves[2]]);
  });

  it("Noblesse Oblige restricts royal captures without affecting other movers", () => {
    const moves = [
      move("d1", "d7", "queen", "rook"),
      move("d1", "d8", "queen", "queen"),
      move("a1", "a8", "rook", "rook"),
      move("e1", "f1", "king"),
    ];
    expect(noblesseObligeRule.filterLegalMoves(context(BASE_FEN), moves))
      .toEqual([moves[1], moves[2], moves[3]]);
  });

  it("Bongcloud activates only while the color-relative king is on its back rank", () => {
    const moves = [
      move("g1", "f3", "knight"),
      move("e2", "e4", "pawn"),
      move("e1", "e2", "king"),
    ];
    expect(bongcloudRule.filterLegalMoves(
      context("4k3/8/8/8/8/8/4P3/4K1N1 w - - 0 1"),
      moves,
    )).toEqual([moves[1], moves[2]]);
    expect(bongcloudRule.filterLegalMoves(
      context("4k3/8/8/8/8/4K3/4P3/6N1 w - - 0 1"),
      moves,
    )).toEqual(moves);
  });

  it("Eat Your Vegetables unlocks non-pawn targets at four opposing pawns", () => {
    const moves = [
      move("c3", "d5", "knight", "rook"),
      move("c3", "b5", "knight", "pawn"),
      move("c3", "a4", "knight"),
    ];
    expect(eatYourVegetablesRule.filterLegalMoves(
      context("4k3/ppppp3/8/8/8/2N5/8/4K3 w - - 0 1"),
      moves,
    )).toEqual([moves[1], moves[2]]);
    expect(eatYourVegetablesRule.filterLegalMoves(
      context("4k3/pppp4/8/8/8/2N5/8/4K3 w - - 0 1"),
      moves,
    )).toEqual(moves);
  });

  it("Horse Eats First restricts captures only while an own knight exists", () => {
    const moves = [
      move("a1", "a8", "rook", "rook"),
      move("c3", "d5", "knight", "pawn"),
      move("a1", "a2", "rook"),
    ];
    expect(horseEatsFirstRule.filterLegalMoves(
      context("4k3/8/8/8/8/2N5/8/R3K3 w - - 0 1"),
      moves,
    )).toEqual([moves[1], moves[2]]);
    expect(horseEatsFirstRule.filterLegalMoves(
      context("4k3/8/8/8/8/8/8/R3K3 w - - 0 1"),
      moves,
    )).toEqual(moves);
  });

  it("Messy Divorce separates files a-d from e-h", () => {
    const moves = [
      move("d4", "e4", "rook"),
      move("e4", "d4", "rook"),
      move("a1", "d1", "rook"),
      move("e1", "h1", "rook"),
    ];
    expect(messyDivorceRule.filterLegalMoves(context(BASE_FEN), moves))
      .toEqual([moves[2], moves[3]]);
  });

  it("classifies en-passant, promotion, and castling by the primary mover", () => {
    const enPassant: ChessMove = {
      ...move("e5", "d6", "pawn", "pawn"),
      flags: "capture,en-passant",
    };
    const capturingPromotion: ChessMove = {
      ...move("g7", "h8", "pawn", "rook"),
      promotion: "queen",
      flags: "capture,promotion",
    };
    const castle: ChessMove = {
      ...move("e1", "g1", "king"),
      san: "O-O",
      flags: "king-side-castle",
    };
    expect(eisoptrophobiaRule.filterLegalMoves(
      context(BASE_FEN),
      [enPassant, capturingPromotion],
    )).toEqual([capturingPromotion]);
    expect(gloomstalkerRule.filterLegalMoves(
      context(BASE_FEN),
      [enPassant],
    )).toEqual([enPassant]);
    expect(noblesseObligeRule.filterLegalMoves(
      context(BASE_FEN),
      [capturingPromotion],
    )).toEqual([capturingPromotion]);
    expect(bongcloudRule.filterLegalMoves(
      context("4k3/8/8/8/8/8/8/4K2R w K - 0 1"),
      [castle],
    )).toEqual([castle]);
  });
});

describe("third observed loss batch", () => {
  it("Body Snatcher remembers any opponent equivalent non-pawn capture", () => {
    const sameType = move("c6", "d4", "knight", "knight", "black");
    const pawnTarget = move("c6", "d4", "knight", "pawn", "black");
    expect(bodySnatcherRule.checkStartOfTurnLoss(
      context(BASE_FEN, "white", [sameType, pawnTarget]),
    )).not.toBeNull();
    expect(bodySnatcherRule.checkStartOfTurnLoss(
      context(BASE_FEN, "white", [pawnTarget]),
    )).toBeNull();
  });

  it("Castle Doctrine and My Kingdom inspect opponent capture history", () => {
    const rookCapture = move("a8", "a1", "rook", "rook", "black");
    const knightCapture = move("c6", "d4", "bishop", "knight", "black");
    expect(castleDoctrineRule.checkStartOfTurnLoss(
      context(BASE_FEN, "white", [rookCapture]),
    )).not.toBeNull();
    expect(myKingdomForAHorseRule.checkStartOfTurnLoss(
      context(BASE_FEN, "white", [knightCapture]),
    )).not.toBeNull();
    expect(castleDoctrineRule.checkStartOfTurnLoss(
      context(BASE_FEN, "black", [rookCapture]),
    )).toBeNull();
  });

  it("Octomom loses on the eighth opposing capture but not the seventh", () => {
    const captures = Array.from({ length: 8 }, () =>
      move("a8", "a1", "rook", "pawn", "black"));
    expect(octomomRule.checkStartOfTurnLoss(
      context(BASE_FEN, "white", captures.slice(0, 7)),
    )).toBeNull();
    expect(octomomRule.checkStartOfTurnLoss(
      context(BASE_FEN, "white", captures),
    )).not.toBeNull();
  });

  it("Pawn Battle compares only current pawns", () => {
    expect(pawnBattleRule.checkStartOfTurnLoss(context(
      "4k3/pp6/8/8/8/8/P7/4K3 w - - 0 1",
    ))).not.toBeNull();
    expect(pawnBattleRule.checkStartOfTurnLoss(context(
      "4k3/p7/8/8/8/8/P7/4K3 w - - 0 1",
    ))).toBeNull();
  });

  it("Edgelord uses the outside files and ranks as the rim", () => {
    expect(edgelordRule.checkStartOfTurnLoss(context(
      "k7/8/8/8/7r/8/4K3/8 w - - 0 1",
    ))).not.toBeNull();
    expect(edgelordRule.checkStartOfTurnLoss(context(
      "k7/8/8/8/8/8/8/R3K3 w - - 0 1",
    ))).toBeNull();
  });

  it("Botez Gambit checks FEN fullmove eleven for either color", () => {
    const failedFen = "3qk3/8/8/8/8/8/8/3QK3 w - - 0 11";
    const passedFen = "3qk3/8/8/8/8/8/8/4K3 w - - 0 11";
    expect(botezGambitRule.checkStartOfTurnLoss(
      context(failedFen),
    )).not.toBeNull();
    expect(botezGambitRule.checkStartOfTurnLoss(
      context(passedFen),
    )).toBeNull();
    expect(botezGambitRule.checkStartOfTurnLoss(
      context(failedFen.replace(" 0 11", " 0 10")),
    )).toBeNull();
    expect(botezGambitRule.checkStartOfTurnLoss(context(
      "3qk3/8/8/8/8/8/8/3QK3 b - - 0 11",
      "black",
    ))).not.toBeNull();
  });
});
