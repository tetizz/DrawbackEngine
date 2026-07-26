import { describe, expect, it } from "vitest";
import {
  UnsupportedDrawbackLeafPositionError,
  type LeafPosition,
} from "@drawbackengine/drawback-search";
import { UciClient } from "./client.js";
import { MockUciTransport } from "./mock-transport.js";
import { createStockfishLeafEvaluator } from "./stockfish-leaf-evaluator.js";

const FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function leaf(orthodoxCompatible = true): LeafPosition {
  return {
    authorityId: "capturable-king/v1",
    fen: FEN,
    turn: "white",
    legalMoves: [
      {
        from: "e2",
        to: "e4",
        color: "white",
        piece: "pawn",
        san: "e4",
        flags: "quiet",
      },
      {
        from: "d2",
        to: "d4",
        color: "white",
        piece: "pawn",
        san: "d4",
        flags: "quiet",
      },
    ],
    history: [],
    orthodoxCompatible,
    kingPassantActive: false,
  };
}

describe("createStockfishLeafEvaluator", () => {
  it("resets Stockfish and searches only exact compatible drawback roots", async () => {
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: [
          "id name Stockfish Test",
          "option name Clear Hash type button",
          "uciok",
        ],
      },
      { command: "isready", responses: ["readyok"] },
      { command: "ucinewgame" },
      { command: "setoption name Clear Hash" },
      { command: "isready", responses: ["readyok"] },
      { command: `position fen ${FEN}` },
      {
        command: "go depth 7 searchmoves d2d4 e2e4",
        responses: [
          "info depth 7 nodes 100 score cp 42 pv d2d4 d7d5",
          "bestmove d2d4",
        ],
      },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    const evaluator = createStockfishLeafEvaluator({
      client,
      depth: 7,
    });

    await expect(evaluator.evaluate(leaf())).resolves.toBe(42);
    expect(transport.complete).toBe(true);
  });

  it("fails closed for a non-orthodox line without issuing UCI commands", async () => {
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: ["id name Stockfish Test", "uciok"],
      },
      { command: "isready", responses: ["readyok"] },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    const evaluator = createStockfishLeafEvaluator({
      client,
      depth: 7,
    });

    await expect(evaluator.evaluate(leaf(false))).rejects.toThrow(
      "cannot evaluate a non-orthodox",
    );
    expect(transport.commands).toEqual(["uci", "isready"]);
  });

  it("rejects a mixed exact move set instead of hiding synthetic replies", async () => {
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: ["id name Stockfish Test", "uciok"],
      },
      { command: "isready", responses: ["readyok"] },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    const evaluator = createStockfishLeafEvaluator({
      client,
      depth: 7,
    });
    const mixed: LeafPosition = {
      authorityId: "capturable-king/v1",
      fen: "4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1",
      turn: "white",
      legalMoves: [
        {
          from: "e2",
          to: "a2",
          color: "white",
          piece: "rook",
          san: "Ra2",
          flags: "quiet",
        },
        {
          from: "e2",
          to: "e3",
          color: "white",
          piece: "rook",
          san: "Re3",
          flags: "quiet",
        },
      ],
      history: [],
      orthodoxCompatible: true,
      kingPassantActive: false,
    };

    await expect(evaluator.evaluate(mixed)).rejects.toThrow(
      "contains non-orthodox moves",
    );
    expect(transport.commands).toEqual(["uci", "isready"]);
  });

  it("serializes concurrent evaluations on one borrowed UCI client", async () => {
    const resetAndSearch = (score: number) => [
      { command: "ucinewgame" },
      { command: "setoption name Clear Hash" },
      { command: "isready", responses: ["readyok"] },
      { command: `position fen ${FEN}` },
      {
        command: "go depth 7 searchmoves d2d4 e2e4",
        responses: [
          `info depth 7 nodes 100 score cp ${String(score)} pv d2d4 d7d5`,
          "bestmove d2d4",
        ],
      },
    ] as const;
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: [
          "id name Stockfish Test",
          "option name Clear Hash type button",
          "uciok",
        ],
      },
      { command: "isready", responses: ["readyok"] },
      ...resetAndSearch(42),
      ...resetAndSearch(17),
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    const evaluator = createStockfishLeafEvaluator({
      client,
      depth: 7,
    });

    await expect(
      Promise.all([evaluator.evaluate(leaf()), evaluator.evaluate(leaf())]),
    ).resolves.toEqual([42, 17]);
    expect(transport.complete).toBe(true);
  });

  it.each(["lowerbound", "upperbound"] as const)(
    "rejects a non-exact %s score",
    async (bound) => {
      const transport = new MockUciTransport([
        {
          command: "uci",
          responses: [
            "id name Stockfish Test",
            "option name Clear Hash type button",
            "uciok",
          ],
        },
        { command: "isready", responses: ["readyok"] },
        { command: "ucinewgame" },
        { command: "setoption name Clear Hash" },
        { command: "isready", responses: ["readyok"] },
        { command: `position fen ${FEN}` },
        {
          command: "go depth 7 searchmoves d2d4 e2e4",
          responses: [
            `info depth 7 nodes 100 score cp 42 ${bound} pv d2d4 d7d5`,
            "bestmove d2d4",
          ],
        },
      ]);
      const client = new UciClient(transport);
      await client.initialize();
      const evaluator = createStockfishLeafEvaluator({
        client,
        depth: 7,
      });

      const pending = evaluator.evaluate(leaf());
      await expect(pending).rejects.toThrow(
        "instead of an exact leaf score",
      );
      await expect(pending).rejects.not.toBeInstanceOf(
        UnsupportedDrawbackLeafPositionError,
      );
      expect(transport.complete).toBe(true);
    },
  );

  it("treats a missing engine score as an operational failure", async () => {
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: [
          "id name Stockfish Test",
          "option name Clear Hash type button",
          "uciok",
        ],
      },
      { command: "isready", responses: ["readyok"] },
      { command: "ucinewgame" },
      { command: "setoption name Clear Hash" },
      { command: "isready", responses: ["readyok"] },
      { command: `position fen ${FEN}` },
      {
        command: "go depth 7 searchmoves d2d4 e2e4",
        responses: ["bestmove d2d4"],
      },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    const evaluator = createStockfishLeafEvaluator({
      client,
      depth: 7,
    });

    const pending = evaluator.evaluate(leaf());
    await expect(pending).rejects.toThrow(
      "returned no score for the exact leaf request",
    );
    await expect(pending).rejects.not.toBeInstanceOf(
      UnsupportedDrawbackLeafPositionError,
    );
    expect(transport.complete).toBe(true);
  });
});
