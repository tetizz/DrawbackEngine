import { describe, expect, it } from "vitest";
import type { ChessMove, PieceType } from "../types.js";
import {
  atomicBombRule,
  getDownMrPresidentRule,
  guerillaTacticsRule,
  princeCharmingRule,
  remainingResponseRules,
  saviorComplexRule,
  shellshockedRule,
  skittishRule,
  sleepyKingRule,
  threeCheckRule,
} from "./remaining-response-rules.js";

function move(
  color: ChessMove["color"],
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly captured?: PieceType;
    readonly san?: string;
    readonly flags?: string;
  } = {},
): ChessMove {
  return {
    color,
    from,
    to,
    piece,
    san: options.san ?? `${from}-${to}`,
    flags: options.flags ??
      (options.captured === undefined ? "quiet" : "capture"),
    ...(options.captured === undefined ? {} : { captured: options.captured }),
  };
}

function context(
  fen: string,
  history: readonly ChessMove[] = [],
  color: ChessMove["color"] = "white",
) {
  return {
    color,
    parameters: {},
    state: {
      movesApplied: history.filter((entry) => entry.color === color).length,
    },
    position: { fen, turn: color, ply: history.length, history },
  };
}

const KINGS = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";

describe("remaining response rules", () => {
  it("has unique implemented-unverified metadata and immutable filters", () => {
    expect(remainingResponseRules).toHaveLength(9);
    expect(new Set(remainingResponseRules.map(({ id }) => id)).size).toBe(9);
    const candidate = Object.freeze(move("white", "a2", "a3", "pawn"));
    const ordinary = Object.freeze([candidate]);
    for (const rule of remainingResponseRules) {
      expect(rule.filterLegalMoves(context(KINGS), ordinary)).not.toBe(ordinary);
      expect(rule.verification).toBe("implemented-unverified");
    }
  });

  it("Atomic Bomb uses the captured piece square including en-passant", () => {
    const capture = move("black", "d3", "e2", "rook", {
      captured: "pawn",
      san: "Rxe2+",
    });
    expect(atomicBombRule.checkStartOfTurnLoss(context(
      "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1",
      [capture],
    ))).toMatchObject({ ruleId: "atomic-bomb" });

    const enPassant = move("black", "e4", "d3", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
      san: "exd3",
    });
    expect(atomicBombRule.checkStartOfTurnLoss(context(
      "4k3/8/8/2K5/8/3p4/8/8 w - - 0 1",
      [enPassant],
    ))).toMatchObject({ ruleId: "atomic-bomb" });
    expect(atomicBombRule.checkStartOfTurnLoss(context(
      "4k3/8/8/8/8/3p4/2K5/8 w - - 0 1",
      [enPassant],
    ))).toBeNull();
  });

  it("Get Down Mr. President forbids king evasions only while checked", () => {
    const checked = "k7/8/8/8/8/8/2nR4/4K3 w - - 0 1";
    const king = move("white", "e1", "d1", "king");
    const block = move("white", "e2", "e8", "rook");
    expect(getDownMrPresidentRule.filterLegalMoves(
      context(checked),
      [king, block],
    )).toEqual([block]);
    expect(getDownMrPresidentRule.filterLegalMoves(
      context(KINGS),
      [king, block],
    )).toEqual([king, block]);
  });

  it("Guerilla Tactics forces an available exact return after capture", () => {
    const capture = move("white", "c2", "d4", "knight", {
      captured: "pawn",
      san: "Nxd4",
    });
    const back = move("white", "d4", "c2", "knight");
    const other = move("white", "a2", "a3", "pawn");
    expect(guerillaTacticsRule.filterLegalMoves(
      context(KINGS, [capture]),
      [back, other],
    )).toEqual([back]);
    expect(guerillaTacticsRule.filterLegalMoves(
      context(KINGS, [capture]),
      [other],
    )).toEqual([other]);
  });

  it("Prince Charming forces knights only when an own queen is attacked", () => {
    const attacked = "3r2k1/8/8/8/8/8/8/3QK1N1 w - - 0 1";
    const knight = move("white", "g1", "f3", "knight");
    const queen = move("white", "d1", "d2", "queen");
    expect(princeCharmingRule.filterLegalMoves(
      context(attacked),
      [knight, queen],
    )).toEqual([knight]);
    expect(princeCharmingRule.filterLegalMoves(
      context(attacked),
      [queen],
    )).toEqual([queen]);
  });

  it("Savior Complex and Skittish select different checked responders", () => {
    const checked = "k7/8/8/8/8/8/2nQ4/4K3 w - - 0 1";
    const king = move("white", "e1", "d1", "king");
    const queen = move("white", "e2", "e8", "queen");
    expect(saviorComplexRule.filterLegalMoves(
      context(checked),
      [king, queen],
    )).toEqual([queen]);
    expect(skittishRule.filterLegalMoves(
      context(checked),
      [king, queen],
    )).toEqual([king]);
  });

  it("Sleepy King wakes in check without forcing a king move", () => {
    const king = move("white", "e1", "d1", "king");
    const queen = move("white", "e2", "e8", "queen");
    expect(sleepyKingRule.filterLegalMoves(
      context(KINGS),
      [king, queen],
    )).toEqual([queen]);
    expect(sleepyKingRule.filterLegalMoves(
      context("k7/8/8/8/8/8/2nQ4/4K3 w - - 0 1"),
      [king, queen],
    )).toEqual([king, queen]);
  });

  it("Shellshocked freezes origins adjacent to a recent victim square", () => {
    const capture = move("black", "d5", "e4", "pawn", {
      captured: "pawn",
      san: "dxe4",
    });
    const adjacent = move("white", "d3", "d4", "rook");
    const distant = move("white", "a2", "a3", "pawn");
    expect(shellshockedRule.filterLegalMoves(
      context(KINGS, [capture]),
      [adjacent, distant],
    )).toEqual([distant]);
    expect(shellshockedRule.filterLegalMoves(
      context(KINGS, [move("black", "d5", "d4", "pawn")]),
      [adjacent, distant],
    )).toEqual([adjacent, distant]);
  });

  it("Shellshocked uses the en-passant victim square and checks castling rooks", () => {
    const enPassant = move("black", "e4", "d3", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
      san: "exd3",
    });
    const byVictim = move("white", "c3", "c4", "rook");
    const byLandingOnly = move("white", "c2", "c1", "rook");
    expect(shellshockedRule.filterLegalMoves(
      context(KINGS, [enPassant]),
      [byVictim, byLandingOnly],
    )).toEqual([byLandingOnly]);

    const captureNearRook = move("black", "g3", "h2", "bishop", {
      captured: "pawn",
      san: "Bxh2",
    });
    const castle = move("white", "e1", "g1", "king", {
      flags: "kingside-castle",
      san: "O-O",
    });
    expect(shellshockedRule.filterLegalMoves(
      context(KINGS, [captureNearRook]),
      [castle],
    )).toEqual([]);
  });

  it("Three Check counts opponent SAN checks and ignores own checks", () => {
    const history = [
      move("black", "a8", "a1", "rook", { san: "Ra1+" }),
      move("white", "h1", "h8", "rook", { san: "Rh8+" }),
      move("black", "a1", "a2", "rook", { san: "Ra2+" }),
    ];
    expect(threeCheckRule.checkStartOfTurnLoss(context(KINGS, history)))
      .toBeNull();
    expect(threeCheckRule.checkStartOfTurnLoss(context(
      KINGS,
      [...history, move("black", "a2", "e2", "rook", { san: "Re2#" })],
    ))).toMatchObject({ ruleId: "three-check" });
  });

  it("mirrors check-based filters for Black", () => {
    const checked = "4k3/q7/8/1B6/8/8/8/K7 b - - 0 1";
    const king = move("black", "e8", "d8", "king");
    const queen = move("black", "a7", "a1", "queen");
    expect(skittishRule.filterLegalMoves(
      context(checked, [], "black"),
      [king, queen],
    )).toEqual([king]);
  });
});
