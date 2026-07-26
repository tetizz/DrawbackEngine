import { describe, expect, it } from "vitest";
import { CapturableKingPosition } from "./capturable-king-position.js";

function hasMove(
  position: CapturableKingPosition,
  from: string,
  to: string,
): boolean {
  return position
    .legalMoves()
    .some((move) => move.from === from && move.to === to);
}

describe("CapturableKingPosition", () => {
  it("allows check to be ignored, pinned pieces to move, and kings to enter attack", () => {
    const pinned = CapturableKingPosition.fromFen(
      "4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1",
    );
    expect(hasMove(pinned, "e2", "a2")).toBe(true);

    const exposedKing = CapturableKingPosition.fromFen(
      "4r2k/8/8/8/8/8/8/4K3 w - - 0 1",
    );
    expect(hasMove(exposedKing, "e1", "e2")).toBe(true);
  });

  it("ends immediately when a king is captured", () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    );
    const capture = position
      .legalMoves()
      .find((move) => move.from === "e7" && move.to === "e8");
    expect(capture).toMatchObject({
      captured: "king",
      san: "Qxe8",
    });

    expect(position.move({ from: "e7", to: "e8" })).toMatchObject({
      terminal: {
        kind: "king-capture",
        winner: "white",
        capturedKing: "black",
        method: "direct",
      },
    });
    expect(position.legalMoves()).toEqual([]);
    expect(position.move({ from: "e8", to: "e7" })).toBeNull();
  });

  it("clears captured-king castling rights in a restorable terminal snapshot", () => {
    const position = CapturableKingPosition.fromFen(
      "r3k2r/4Q3/8/8/8/8/8/R3K2R w KQkq - 0 1",
    );

    const result = position.move({ from: "e7", to: "e8" });

    expect(result?.terminal).toMatchObject({
      kind: "king-capture",
      winner: "white",
      capturedKing: "black",
      method: "direct",
    });
    expect(position.fen.split(" ")[2]).toBe("KQ");
    const snapshot = position.snapshot();
    expect(
      CapturableKingPosition.fromSnapshot(snapshot).snapshot(),
    ).toEqual(snapshot);
  });

  it("generates every promotion choice when a pawn captures the king", () => {
    const position = CapturableKingPosition.fromFen(
      "k7/1P6/8/8/8/8/8/7K w - - 0 1",
    );
    const captures = position
      .legalMoves()
      .filter((move) => move.from === "b7" && move.to === "a8");
    expect(captures.map((move) => move.promotion).sort()).toEqual([
      "bishop",
      "knight",
      "queen",
      "rook",
    ]);
    expect(captures.every((move) => move.captured === "king")).toBe(true);
    expect(
      position.move({ from: "b7", to: "a8", promotion: "knight" }),
    ).toMatchObject({
      terminal: {
        kind: "king-capture",
        winner: "white",
        capturedKing: "black",
      },
    });
  });

  it("permits castling through check and exposes the king en passant", () => {
    const position = CapturableKingPosition.fromFen(
      "5r1k/8/8/8/8/8/8/4K2R w K - 0 1",
    );
    expect(hasMove(position, "e1", "g1")).toBe(true);
    expect(position.move({ from: "e1", to: "g1" })).toMatchObject({
      move: { san: "O-O" },
      terminal: null,
    });

    const kingPassant = position
      .legalMoves()
      .find((move) => move.from === "f8" && move.to === "f1");
    expect(kingPassant).toMatchObject({
      captured: "king",
    });
    expect(kingPassant?.flags).toContain("king-en-passant");
    expect(position.move({ from: "f8", to: "f1" })).toMatchObject({
      terminal: {
        kind: "king-capture",
        winner: "black",
        capturedKing: "white",
        method: "castling-en-passant",
      },
    });
  });

  it("expires castling en passant after the opponent declines it", () => {
    const position = CapturableKingPosition.fromFen(
      "5r1k/8/8/8/8/8/8/4K2R w K - 0 1",
    );
    expect(position.move({ from: "e1", to: "g1" })?.terminal).toBeNull();
    expect(position.move({ from: "h8", to: "h7" })?.terminal).toBeNull();
    expect(position.move({ from: "g1", to: "h2" })?.terminal).toBeNull();
    const later = position
      .legalMoves()
      .find((move) => move.from === "f8" && move.to === "f1");
    expect(later?.captured).toBe("rook");
    expect(later?.flags).not.toContain("king-en-passant");
  });

  it("allows castling into check and a direct capture on the destination", () => {
    const position = CapturableKingPosition.fromFen(
      "6rk/8/8/8/8/8/8/4K2R w K - 0 1",
    );
    expect(position.move({ from: "e1", to: "g1" })?.terminal).toBeNull();
    expect(position.move({ from: "g8", to: "g1" })).toMatchObject({
      terminal: {
        kind: "king-capture",
        winner: "black",
        capturedKing: "white",
        method: "direct",
      },
    });
  });

  it("retains ordinary pawn en passant", () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1",
    );
    expect(position.move({ from: "d7", to: "d5" })?.terminal).toBeNull();
    const enPassant = position
      .legalMoves()
      .find((move) => move.from === "e5" && move.to === "d6");
    expect(enPassant).toMatchObject({ captured: "pawn" });
    expect(enPassant?.flags).toContain("en-passant");

    const black = CapturableKingPosition.fromFen(
      "4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1",
    );
    const blackEnPassant = black
      .legalMoves()
      .find((move) => move.from === "e4" && move.to === "d3");
    expect(blackEnPassant).toMatchObject({
      captured: "pawn",
      san: "exd3",
    });
    expect(blackEnPassant?.flags).toContain("capture");
  });

  it("fails closed on Stockfish compatibility for non-orthodox starts", () => {
    expect(
      CapturableKingPosition.fromFen(
        "8/8/8/8/8/8/4k3/4K3 w - - 0 1",
      ).orthodoxCompatible,
    ).toBe(false);
    expect(
      CapturableKingPosition.fromFen(
        "4k3/3P4/8/8/8/8/8/4K3 w - - 0 1",
      ).orthodoxCompatible,
    ).toBe(false);
  });

  it.each([
    ["missing Black king", "8/8/8/8/8/8/8/K7 w - - 0 1"],
    ["missing White king", "4k3/8/8/8/8/8/8/8 w - - 0 1"],
    ["duplicate White kings", "4k3/8/8/8/8/8/K7/K7 w - - 0 1"],
  ])("rejects a position with %s", (_label, fen) => {
    expect(() => CapturableKingPosition.fromFen(fen)).toThrow(
      "requires exactly one white king and one black king",
    );
  });

  it("keeps clones independent", () => {
    const parent = CapturableKingPosition.fromFen();
    const child = parent.clone();
    expect(child.move({ from: "e2", to: "e4" })).not.toBeNull();
    expect(parent.fen).not.toBe(child.fen);
    expect(parent.turn).toBe("white");
    expect(child.turn).toBe("black");
  });

  it("round-trips and latches a direct king-capture terminal", () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    );
    expect(position.move({ from: "e7", to: "e8" })?.terminal).not.toBeNull();

    const snapshot = position.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.terminal)).toBe(true);
    const restored = CapturableKingPosition.fromSnapshot(snapshot);

    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.legalMoves()).toEqual([]);
    expect(restored.move({ from: "e8", to: "e7" })).toBeNull();
  });

  it("preserves the special castling king-passant right", () => {
    const position = CapturableKingPosition.fromFen(
      "5r1k/8/8/8/8/8/8/4K2R w K - 0 1",
    );
    expect(position.move({ from: "e1", to: "g1" })?.terminal).toBeNull();
    const snapshot = position.snapshot();
    expect(snapshot.kingPassant).toEqual({
      victim: "white",
      kingSquare: "g1",
      targets: ["f1"],
    });

    const restored = CapturableKingPosition.fromSnapshot(snapshot);
    const capture = restored
      .legalMoves()
      .find((move) => move.from === "f8" && move.to === "f1");
    expect(capture).toMatchObject({
      captured: "king",
    });
    expect(capture?.flags).toContain("king-en-passant");
    expect(restored.move({ from: "f8", to: "f1" })).toMatchObject({
      terminal: {
        method: "castling-en-passant",
        winner: "black",
      },
    });
  });

  it("keeps snapshots, restores, and clones isolated", () => {
    const original = CapturableKingPosition.fromFen();
    const snapshot = original.snapshot();
    const restored = CapturableKingPosition.fromSnapshot(snapshot);
    const clone = restored.clone();

    expect(restored.move({ from: "e2", to: "e4" })).not.toBeNull();
    expect(clone.move({ from: "d2", to: "d4" })).not.toBeNull();
    expect(original.fen).toBe(snapshot.fen);
    expect(restored.fen).not.toBe(clone.fen);
    expect(snapshot.fen).not.toBe(restored.fen);
  });

  it.each([
    [
      "unknown fields",
      {
        ...CapturableKingPosition.fromFen().snapshot(),
        secret: "not-public",
      },
    ],
    [
      "fabricated king-passant geometry",
      {
        ...CapturableKingPosition.fromFen(
          "5r1k/8/8/8/8/8/8/4K2R w K - 0 1",
        ).snapshot(),
        kingPassant: {
          victim: "white",
          kingSquare: "g1",
          targets: ["a4"],
        },
      },
    ],
    [
      "fabricated unattacked king-passant right",
      {
        ...CapturableKingPosition.fromFen(
          "7k/8/8/8/8/8/8/5RK1 b - - 1 1",
        ).snapshot(),
        orthodoxCompatible: false,
        kingPassant: {
          victim: "white",
          kingSquare: "g1",
          targets: ["f1"],
        },
      },
    ],
    [
      "false orthodox lineage",
      {
        ...CapturableKingPosition.fromFen(
          "8/8/8/8/8/8/4k3/4K3 w - - 0 1",
        ).snapshot(),
        orthodoxCompatible: true,
      },
    ],
    [
      "terminal with both kings",
      {
        ...CapturableKingPosition.fromFen().snapshot(),
        orthodoxCompatible: false,
        terminal: {
          kind: "king-capture",
          winner: "white",
          capturedKing: "black",
          method: "direct",
          move: {
            from: "e1",
            to: "e8",
            color: "white",
            piece: "queen",
            captured: "king",
            san: "Qxe8",
            flags: "capture",
          },
        },
      },
    ],
  ])("rejects an invalid public snapshot with %s", (_label, snapshot) => {
    expect(() => CapturableKingPosition.fromSnapshot(snapshot)).toThrow();
  });
});
