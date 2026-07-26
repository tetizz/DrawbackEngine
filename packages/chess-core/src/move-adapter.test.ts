import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { toChessMove } from "./move-adapter.js";

function moveFrom(fen: string, san: string) {
  const chess = new Chess(fen);
  return toChessMove(chess.move(san));
}

describe("chess.js move adapter", () => {
  it("classifies en passant as a capture with the captured pawn", () => {
    expect(
      moveFrom("8/8/8/3pP3/8/8/8/K6k w - d6 0 1", "exd6"),
    ).toMatchObject({
      captured: "pawn",
      flags: "capture,en-passant",
    });
  });

  it("keeps ordinary captures and quiet moves distinct", () => {
    expect(
      moveFrom("8/8/8/3p4/4P3/8/8/K6k w - - 0 1", "exd5"),
    ).toMatchObject({
      captured: "pawn",
      flags: "capture",
    });
    expect(
      moveFrom("8/8/8/8/4P3/8/8/K6k w - - 0 1", "e5"),
    ).toMatchObject({
      flags: "quiet",
    });
  });
});
