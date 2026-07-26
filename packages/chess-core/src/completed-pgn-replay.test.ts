import { describe, expect, it } from "vitest";
import {
  CompletedPgnParseError,
  MAX_COMPLETED_PGN_INPUT_BYTES,
  MAX_COMPLETED_PGN_PLIES,
  replayCompletedPgn,
  tokenizeCompletedPgn,
} from "./completed-pgn-replay.js";

function completed(moves: string, result = "1-0"): string {
  return `[Result "${result}"]\n\n${moves} ${result}`;
}

describe("completed PGN replay", () => {
  it("replays a terminal mainline into immutable pre-move facts", () => {
    const replay = replayCompletedPgn(
      '[Event "Offline"]\n[Result "1-0"]\n\n1. e4 {main} e5 2. Nf3 (2. Bc4) Nc6 1-0',
    );

    expect(replay.normalizedMainline).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(replay.steps).toHaveLength(4);
    expect(replay.steps[0]).toMatchObject({
      ply: 1,
      moveNumber: 1,
      color: "white",
      san: "e4",
      fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    });
    expect(replay.steps[0]?.ordinaryLegalMoves).toHaveLength(20);
    expect(replay.steps[1]?.historyBefore.map(({ san }) => san)).toEqual(["e4"]);
    expect(replay.steps.at(-1)?.fenAfter).toBe(replay.finalFen);
    expect(Object.isFrozen(replay.steps)).toBe(true);
    expect(Object.isFrozen(replay.steps[0]?.ordinaryLegalMoves)).toBe(true);
    expect(Object.isFrozen(replay.steps[0]?.ordinaryLegalMoves[0])).toBe(true);
    expect(Object.isFrozen(replay.steps[0]?.move)).toBe(true);
    expect(Object.isFrozen(replay.headers)).toBe(true);
    expect(() => {
      (replay.steps[0]?.move as { san: string }).san = "mutated";
    }).toThrow();
    expect(() => {
      (replay.headers as Map<string, string>).set("Result", "0-1");
    }).toThrow();
    expect(replay.headers.get("Result")).toBe("1-0");
  });

  it("supports setup FEN, castling, en passant, and promotion", () => {
    const castling = replayCompletedPgn(
      '[SetUp "1"]\n[FEN "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"]\n[Result "1/2-1/2"]\n\n1. O-O O-O-O 1/2-1/2',
    );
    expect(castling.steps.map(({ san }) => san)).toEqual(["O-O", "O-O-O"]);
    expect(castling.steps.map(({ move }) => move.flags)).toEqual([
      "quiet,kingside-castle",
      "quiet,queenside-castle",
    ]);
    expect(castling.steps.map(({ fenAfter }) => fenAfter)).toEqual([
      "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1",
      "2kr3r/8/8/8/8/8/8/R4RK1 w - - 2 2",
    ]);

    const enPassant = replayCompletedPgn(
      '[SetUp "1"]\n[FEN "8/8/8/3pP3/8/8/8/K6k w - d6 0 1"]\n[Result "1/2-1/2"]\n\n1. exd6 1/2-1/2',
    );
    expect(enPassant.steps[0]?.move).toMatchObject({
      from: "e5",
      to: "d6",
      captured: "pawn",
      flags: "capture,en-passant",
    });
    expect(enPassant.steps[0]?.fenAfter).toBe(
      "8/8/3P4/8/8/8/8/K6k b - - 0 1",
    );

    const promotion = replayCompletedPgn(
      '[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/K7 w - - 0 1"]\n[Result "1-0"]\n\n1. a8=Q+ 1-0',
    );
    expect(promotion.steps[0]?.move).toMatchObject({
      from: "a7",
      to: "a8",
      promotion: "queen",
      flags: "quiet,promotion",
    });
    expect(promotion.steps[0]?.fenAfter).toBe(
      "Q6k/8/8/8/8/8/8/K7 b - - 0 1",
    );

    const capturePromotion = replayCompletedPgn(
      '[SetUp "1"]\n[FEN "1r5k/P7/8/8/8/8/8/K7 w - - 0 1"]\n[Result "1-0"]\n\n1. axb8=Q+ 1-0',
    );
    expect(capturePromotion.steps[0]?.move).toMatchObject({
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(capturePromotion.steps[0]?.fenAfter).toBe(
      "1Q5k/8/8/8/8/8/8/K7 b - - 0 1",
    );
  });

  it("derives move numbers from custom FEN side and fullmove fields", () => {
    const replay = replayCompletedPgn(
      '[SetUp "1"]\n[FEN "8/8/8/8/8/8/6k1/K6R b - - 0 42"]\n[Result "1/2-1/2"]\n\n42... Kf3 43. Kb1 1/2-1/2',
    );

    expect(
      replay.steps.map(({ moveNumber, color, san }) => ({
        moveNumber,
        color,
        san,
      })),
    ).toEqual([
      { moveNumber: 42, color: "black", san: "Kf3" },
      { moveNumber: 43, color: "white", san: "Kb1" },
    ]);
  });

  it("normalizes annotations while rejecting malformed or ongoing PGNs", () => {
    expect(tokenizeCompletedPgn(completed("1. e4! e5?!"))).toEqual([
      "e4!",
      "e5?!",
    ]);
    expect(() => replayCompletedPgn('[Result "*"]\n\n1. e4 *')).toThrow(
      "matching terminal PGN",
    );
    expect(() => replayCompletedPgn('[Result "1-0"]\n\n1. e4 0-1')).toThrow(
      "matching terminal PGN",
    );
    expect(() => replayCompletedPgn('[SetUp "1"]\n[Result "1-0"]\n\n1. e4 1-0'))
      .toThrow('SetUp "1" without a FEN');
    expect(() => replayCompletedPgn(completed("1. e5"))).toThrow(
      "is not legal",
    );
    expect(() => replayCompletedPgn(completed("1. e4 {open"))).toThrow(
      "Unterminated PGN comment",
    );
  });

  it("enforces byte and ply bounds before replay", () => {
    expect(() => replayCompletedPgn("x".repeat(MAX_COMPLETED_PGN_INPUT_BYTES + 1)))
      .toThrow("byte analysis limit");
    const excessive = Array.from(
      { length: MAX_COMPLETED_PGN_PLIES + 1 },
      () => "e4",
    ).join(" ");
    expect(() => replayCompletedPgn(completed(excessive))).toThrow(
      "ply analysis limit",
    );
  });

  it("exposes structured parse errors", () => {
    try {
      replayCompletedPgn(completed("1. e5"));
      throw new Error("Expected replay to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(CompletedPgnParseError);
      expect(error).toMatchObject({ ply: 1, token: "e5" });
    }
  });
});
