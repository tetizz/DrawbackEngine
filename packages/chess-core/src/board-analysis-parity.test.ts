import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { isInCheck } from "@drawbackengine/drawback-engine";
import { playerColor } from "./move-adapter.js";

function nextSeed(seed: number): number {
  return (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
}

describe("drawback board analysis parity", () => {
  it("matches chess.js check detection across deterministic legal positions", () => {
    const chess = new Chess();
    let seed = 0x5eed_2026;

    for (let position = 0; position < 500; position += 1) {
      const color = playerColor(chess.turn());
      expect(
        isInCheck(chess.fen(), color),
        `check parity at deterministic position ${String(position)}: ${chess.fen()}`,
      ).toBe(chess.isCheck());

      const moves = chess.moves();
      if (moves.length === 0 || position % 100 === 99) {
        chess.reset();
        continue;
      }
      seed = nextSeed(seed);
      chess.move(moves[seed % moves.length] ?? moves[0] ?? "");
    }
  });
});
