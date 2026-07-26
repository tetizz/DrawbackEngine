import { describe, expect, it } from "vitest";
import {
  areAdjacent,
  isInCheck,
  isSquareAttacked,
  isSquareAttackedByQueen,
  isDestinationDefendedAfterMove,
  parseFenPieces,
  projectPiecesAfterMove,
} from "./board-analysis.js";

describe("board analysis", () => {
  it("parses immutable colored pieces from FEN", () => {
    const pieces = parseFenPieces(
      "r3k3/8/8/8/8/8/4P3/4K2R w - - 0 1",
    );
    expect(pieces).toEqual([
      { color: "black", type: "rook", square: "a8" },
      { color: "black", type: "king", square: "e8" },
      { color: "white", type: "pawn", square: "e2" },
      { color: "white", type: "king", square: "e1" },
      { color: "white", type: "rook", square: "h1" },
    ]);
    expect(Object.isFrozen(pieces)).toBe(true);
  });

  it("implements orthogonal and diagonal adjacency", () => {
    expect(areAdjacent("e4", "e5")).toBe(true);
    expect(areAdjacent("e4", "f5")).toBe(true);
    expect(areAdjacent("e4", "e6")).toBe(false);
  });

  it("detects pawn and knight attacks for both colors", () => {
    const fen = "4k3/8/8/3p4/4P3/2N5/8/4K3 w - - 0 1";
    expect(isSquareAttacked(fen, "e4", "black")).toBe(true);
    expect(isSquareAttacked(fen, "d5", "white")).toBe(true);
    expect(isSquareAttacked(fen, "b5", "white")).toBe(true);
    expect(isSquareAttacked(fen, "e5", "white")).toBe(false);
  });

  it("detects slider rays and respects blockers", () => {
    expect(isSquareAttacked(
      "4k3/8/8/8/8/8/8/R3K3 w - - 0 1",
      "a8",
      "white",
    )).toBe(true);
    expect(isSquareAttacked(
      "4k3/8/8/8/P7/8/8/R3K3 w - - 0 1",
      "a8",
      "white",
    )).toBe(false);
    expect(isSquareAttacked(
      "4k3/8/8/8/8/2B5/8/4K3 w - - 0 1",
      "f6",
      "white",
    )).toBe(true);
  });

  it("isolates queen rays from equivalent rook attacks", () => {
    expect(isSquareAttackedByQueen(
      "q3k3/8/8/8/8/8/R7/4K3 w - - 0 1",
      "a2",
      "black",
    )).toBe(true);
    expect(isSquareAttackedByQueen(
      "r3k3/8/8/8/8/8/R7/4K3 w - - 0 1",
      "a2",
      "black",
    )).toBe(false);
  });

  it("projects captures, en-passant, promotions, and castling exactly", () => {
    expect(projectPiecesAfterMove(
      "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
      {
        from: "e5",
        to: "d6",
        color: "white",
        piece: "pawn",
        captured: "pawn",
        san: "exd6",
        flags: "capture,en-passant",
      },
    )).not.toContainEqual({
      color: "black",
      type: "pawn",
      square: "d5",
    });
    expect(projectPiecesAfterMove(
      "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
      {
        from: "a7",
        to: "a8",
        color: "white",
        piece: "pawn",
        promotion: "queen",
        san: "a8=Q",
        flags: "promotion",
      },
    )).toContainEqual({
      color: "white",
      type: "queen",
      square: "a8",
    });
    expect(projectPiecesAfterMove(
      "4k3/8/8/8/8/8/8/4K2R w K - 0 1",
      {
        from: "e1",
        to: "g1",
        color: "white",
        piece: "king",
        san: "O-O",
        flags: "kingside-castle",
      },
    )).toEqual(expect.arrayContaining([
      { color: "white", type: "king", square: "g1" },
      { color: "white", type: "rook", square: "f1" },
    ]));
  });

  it("projects capture flags without optional captured metadata", () => {
    const projected = projectPiecesAfterMove(
      "4k3/8/8/8/8/p7/R7/4K3 w - - 0 1",
      {
        from: "a2",
        to: "a3",
        color: "white",
        piece: "rook",
        san: "Rxa3",
        flags: "capture",
      },
    );
    expect(projected.filter(({ square }) => square === "a3")).toEqual([
      { color: "white", type: "rook", square: "a3" },
    ]);
    expect(projected.some(({ square }) => square === "a2")).toBe(false);
  });

  it("rejects castling projection when the required rook is absent", () => {
    expect(() => projectPiecesAfterMove(
      "4k3/8/8/8/8/8/8/4K3 w K - 0 1",
      {
        from: "e1",
        to: "g1",
        color: "white",
        piece: "king",
        san: "O-O",
        flags: "kingside-castle",
      },
    )).toThrow("castling rook");
  });

  it("evaluates destination defense only after projection", () => {
    const loneRook = {
      from: "a1",
      to: "a2",
      color: "white" as const,
      piece: "rook" as const,
      san: "Ra2",
      flags: "quiet",
    };
    expect(isDestinationDefendedAfterMove(
      "4k3/8/8/8/8/8/8/R3K3 w - - 0 1",
      loneRook,
    )).toBe(false);
    expect(isDestinationDefendedAfterMove(
      "4k3/8/8/8/8/8/8/RK6 w - - 0 1",
      loneRook,
    )).toBe(true);
    expect(isDestinationDefendedAfterMove(
      "4k3/8/8/8/8/8/8/4K2R w K - 0 1",
      {
        from: "e1",
        to: "g1",
        color: "white",
        piece: "king",
        san: "O-O",
        flags: "kingside-castle",
      },
    )).toBe(true);
  });

  it("detects direct and discovered checks", () => {
    expect(isInCheck(
      "4k3/8/8/8/8/8/4R3/4K3 b - - 0 1",
      "black",
    )).toBe(true);
    expect(isInCheck(
      "4k3/8/8/8/8/8/4B3/4R1K1 b - - 0 1",
      "black",
    )).toBe(false);
  });

  it("fails closed on malformed placement", () => {
    expect(() => parseFenPieces("8/8/8/8/8/8/8 w - - 0 1"))
      .toThrow("eight ranks");
    expect(() => isSquareAttacked(
      "8/8/8/8/8/8/8/8 w - - 0 1",
      "z9",
      "white",
    )).toThrow("Invalid chess square");
  });
});
