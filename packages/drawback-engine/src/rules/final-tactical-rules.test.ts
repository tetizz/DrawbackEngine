import { Chess, type Move, type PieceSymbol } from "chess.js";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  PositionView,
  PromotionPiece,
} from "../types.js";
import {
  dragRule,
  finalTacticalRules,
  oohShinyRule,
  type DragState,
} from "./final-tactical-rules.js";

const PIECES: Readonly<Record<PieceSymbol, PieceType>> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

function chessMove(move: Move): ChessMove {
  return {
    from: move.from,
    to: move.to,
    color: move.color === "w" ? "white" : "black",
    piece: PIECES[move.piece],
    ...(move.captured === undefined
      ? {}
      : { captured: PIECES[move.captured] }),
    ...(move.promotion === undefined
      ? {}
      : { promotion: PIECES[move.promotion] as PromotionPiece }),
    san: move.san,
    flags: [
      move.isCapture() ? "capture" : "quiet",
      move.isPromotion() ? "promotion" : "",
      move.isEnPassant() ? "en-passant" : "",
    ].filter(Boolean).join(","),
  };
}

function moves(fen: string): readonly ChessMove[] {
  return new Chess(fen).moves({ verbose: true }).map(chessMove);
}

function position(
  fen: string,
  history: readonly ChessMove[] = [],
  color: ChessMove["color"] = "white",
): PositionView {
  return { fen, history, turn: color, ply: history.length };
}

function dragContext(
  fen: string,
  state: DragState,
  history: readonly ChessMove[] = [],
) {
  return {
    color: "white" as const,
    parameters: {},
    state,
    position: position(fen, history),
  };
}

function shinyContext(fen: string) {
  return {
    color: "white" as const,
    parameters: {},
    state: { movesApplied: 0 },
    position: position(fen),
  };
}

function codes(candidates: readonly ChessMove[]): readonly string[] {
  return candidates.map(
    (move) => `${move.from}${move.to}${move.promotion?.[0] ?? ""}`,
  );
}

describe("final tactical rules", () => {
  it("exports two unique implemented-unverified rules", () => {
    expect(finalTacticalRules.map((rule) => rule.id)).toEqual([
      "drag",
      "ooh-shiny",
    ]);
    expect(finalTacticalRules.every(
      (rule) => rule.verification === "implemented-unverified",
    )).toBe(true);
  });

  it("Drag limits only the tracked original queen to one square", () => {
    const fen = "4k3/8/8/8/8/8/4P3/3QK3 w - - 0 1";
    const legal = moves(fen);
    const filtered = dragRule.filterLegalMoves(
      dragContext(fen, { movesApplied: 0, queenSquare: "d1" }),
      legal,
    );
    expect(codes(legal)).toContain("d1d7");
    expect(codes(filtered)).not.toContain("d1d7");
    expect(codes(filtered)).toContain("d1c2");
    expect(codes(filtered)).toContain("e2e3");
  });

  it("Drag leaves promoted queens unrestricted and follows original-queen history", () => {
    const originalMove: ChessMove = {
      from: "d1",
      to: "a4",
      color: "white",
      piece: "queen",
      san: "Qa4",
      flags: "quiet",
    };
    const initialized = dragRule.initialize({
      color: "white",
      parameters: {},
      position: position(
        "4k3/8/8/8/Q7/8/8/4K3 b - - 0 1",
        [originalMove],
        "black",
      ),
    });
    expect(initialized).toEqual({ movesApplied: 1, queenSquare: "a4" });

    const fen = "4k3/Q7/8/8/8/8/8/3QK3 w - - 0 1";
    const filtered = dragRule.filterLegalMoves(
      dragContext(fen, { movesApplied: 0, queenSquare: "d1" }),
      moves(fen),
    );
    expect(codes(filtered)).toContain("a7a1");
  });

  it("Drag reports loss when the tracked queen is absent or replaced", () => {
    expect(dragRule.checkStartOfTurnLoss(
      dragContext(
        "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
        { movesApplied: 1, queenSquare: "a4" },
      ),
    )).toMatchObject({ ruleId: "drag", color: "white" });
    expect(dragRule.checkStartOfTurnLoss(
      dragContext(
        "4k3/8/8/8/Q7/8/8/4K3 w - - 0 1",
        { movesApplied: 1, queenSquare: "a4" },
      ),
    )).toBeNull();
  });

  it("Ooh Shiny forces a safe capture and leaves unsafe captures optional", () => {
    const safeFen = "4k3/p7/8/8/8/8/8/R3K3 w - - 0 1";
    expect(codes(oohShinyRule.filterLegalMoves(
      shinyContext(safeFen),
      moves(safeFen),
    ))).toEqual(["a1a7"]);

    const unsafeFen = "r3k3/p7/8/8/8/8/8/R3K3 w - - 0 1";
    const ordinary = moves(unsafeFen);
    expect(oohShinyRule.filterLegalMoves(
      shinyContext(unsafeFen),
      ordinary,
    )).toEqual(ordinary);
  });

  it("Ooh Shiny excludes a pinned would-be recapturer", () => {
    const fen = "4k3/3pr3/8/8/6B1/8/8/K2RR3 w - - 0 1";
    const filtered = oohShinyRule.filterLegalMoves(
      shinyContext(fen),
      moves(fen),
    );
    expect(codes(filtered)).toContain("g4d7");
    expect(filtered.every((move) => move.captured !== undefined)).toBe(true);
  });

  it("Ooh Shiny handles en passant and all capture-promotion choices", () => {
    const enPassantFen = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1";
    expect(codes(oohShinyRule.filterLegalMoves(
      shinyContext(enPassantFen),
      moves(enPassantFen),
    ))).toEqual(["e5d6"]);

    const promotionFen = "4k2r/6P1/8/8/8/8/8/4K3 w - - 0 1";
    expect(new Set(codes(oohShinyRule.filterLegalMoves(
      shinyContext(promotionFen),
      moves(promotionFen),
    )))).toEqual(new Set([
      "g7h8q",
      "g7h8r",
      "g7h8b",
      "g7h8k",
    ]));
  });

  it("Ooh Shiny treats a capture delivering checkmate as safe", () => {
    const fen = "7k/7p/6Q1/8/8/8/8/5K1R w - - 0 1";
    const filtered = oohShinyRule.filterLegalMoves(
      shinyContext(fen),
      moves(fen),
    );
    expect(codes(filtered)).toContain("g6h7");
    expect(filtered.find((move) => move.from === "g6")?.san).toBe("Qxh7#");
  });

  it("never mutates the ordinary legal move array", () => {
    const fen = "4k3/p7/8/8/8/8/8/R3K3 w - - 0 1";
    const ordinary = moves(fen);
    const snapshot = structuredClone(ordinary);
    oohShinyRule.filterLegalMoves(shinyContext(fen), ordinary);
    expect(ordinary).toEqual(snapshot);
  });
});
