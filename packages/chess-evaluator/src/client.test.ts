import { describe, expect, it } from "vitest";
import {
  MockUciTransport,
  UciClient,
  UciProtocolError,
  parseBestMove,
  parseInfo,
} from "./index.js";

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function initializedSteps() {
  return [
    {
      command: "uci",
      responses: [
        "id name Stockfish Test",
        "id author Mock Author",
        "option name Threads type spin default 1 min 1 max 1024",
        "uciok",
      ],
    },
    { command: "isready", responses: ["readyok"] },
  ] as const;
}

describe("UciClient", () => {
  it("performs the UCI and readiness handshake", async () => {
    const transport = new MockUciTransport(initializedSteps());
    const client = new UciClient(transport);
    await expect(client.initialize()).resolves.toEqual({
      name: "Stockfish Test",
      author: "Mock Author",
      options: ["option name Threads type spin default 1 min 1 max 1024"],
    });
    expect(transport.commands).toEqual(["uci", "isready"]);
    expect(transport.complete).toBe(true);
  });

  it("validates and applies required options before initial readiness", async () => {
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: [
          "id name Stockfish Test",
          "option name Threads type spin default 1 min 1 max 1024",
          "option name Ponder type check default false",
          "uciok",
        ],
      },
      { command: "setoption name Threads value 1" },
      { command: "setoption name Ponder value false" },
      { command: "isready", responses: ["readyok"] },
    ]);
    const client = new UciClient(transport, {
      options: [
        { name: "threads", value: 1 },
        { name: "Ponder", value: false },
      ],
    });

    await client.initialize();

    expect(transport.commands).toEqual([
      "uci",
      "setoption name Threads value 1",
      "setoption name Ponder value false",
      "isready",
    ]);
    expect(transport.complete).toBe(true);
  });

  it("fails closed for unsupported and malformed option configuration", async () => {
    const unsupported = new MockUciTransport([
      {
        command: "uci",
        responses: [
          "option name Threads type spin default 1 min 1 max 1024",
          "uciok",
        ],
      },
    ]);
    const client = new UciClient(unsupported, {
      options: [{ name: "Hash", value: 64 }],
    });
    await expect(client.initialize()).rejects.toThrow(
      "does not advertise required UCI option: Hash",
    );
    expect(unsupported.commands).toEqual(["uci"]);

    expect(
      () => new UciClient(new MockUciTransport([]), {
        options: [{ name: "Threads\nquit", value: 1 }],
      }),
    ).toThrow("single-line");
  });

  it("evaluates a FEN and retains the latest centipawn search info", async () => {
    const transport = new MockUciTransport([
      ...initializedSteps(),
      { command: `position fen ${FEN}` },
      {
        command: "go depth 12",
        responses: [
          "info depth 8 seldepth 10 nodes 500 score cp 18 pv e2e4 e7e5",
          "info depth 12 seldepth 16 nodes 2500 score cp 31 lowerbound pv d2d4 d7d5",
          "bestmove d2d4 ponder d7d5",
        ],
      },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    await expect(client.evaluateFen(FEN, { depth: 12 })).resolves.toEqual({
      bestMove: "d2d4",
      ponderMove: "d7d5",
      score: { kind: "centipawns", value: 31, bound: "lower" },
      depth: 12,
      nodes: 2500,
      principalVariation: ["d2d4", "d7d5"],
    });
  });

  it("parses mate scores and terminal no-move responses", async () => {
    const transport = new MockUciTransport([
      ...initializedSteps(),
      { command: `position fen ${FEN}` },
      {
        command: "go movetime 25",
        responses: [
          "info depth 20 score mate -3 upperbound nodes 99 pv e1e2",
          "bestmove (none)",
        ],
      },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    const result = await client.evaluateFen(FEN, { moveTimeMs: 25 });
    expect(result.bestMove).toBeNull();
    expect(result.score).toEqual({ kind: "mate", moves: -3, bound: "upper" });
  });

  it("restricts search to validated drawback-legal root moves", async () => {
    const transport = new MockUciTransport([
      ...initializedSteps(),
      { command: `position fen ${FEN}` },
      {
        command: "go depth 4 searchmoves e2e4 d2d4",
        responses: ["info depth 4 score cp 12 pv e2e4", "bestmove e2e4"],
      },
    ]);
    const client = new UciClient(transport);
    await client.initialize();

    await expect(
      client.evaluateFen(FEN, { depth: 4 }, ["e2e4", "d2d4"]),
    ).resolves.toMatchObject({ bestMove: "e2e4" });
    await expect(
      client.evaluateFen(FEN, { depth: 4 }, ["not-a-move"]),
    ).rejects.toThrow("Invalid UCI root move");
    await expect(
      client.evaluateFen(FEN, { depth: 4 }, ["e2e4", "e2e4"]),
    ).rejects.toThrow("Duplicate UCI root move");
  });

  it("rejects an engine best move outside the requested root mask", async () => {
    const transport = new MockUciTransport([
      ...initializedSteps(),
      { command: `position fen ${FEN}` },
      {
        command: "go nodes 10 searchmoves e2e4",
        responses: ["bestmove d2d4"],
      },
    ]);
    const client = new UciClient(transport);
    await client.initialize();

    await expect(
      client.evaluateFen(FEN, { nodes: 10 }, ["e2e4"]),
    ).rejects.toThrow("outside the requested root moves");
    await expect(client.ready()).rejects.toThrow("unusable");
  });

  it("synchronizes a new game before the next search", async () => {
    const transport = new MockUciTransport([
      ...initializedSteps(),
      { command: "ucinewgame" },
      { command: "isready", responses: ["readyok"] },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    await client.newGame();
    expect(transport.complete).toBe(true);
  });

  it("configures options and performs explicit reset and readiness barriers", async () => {
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: [
          "option name Hash type spin default 16 min 1 max 33554432",
          "option name Clear Hash type button",
          "uciok",
        ],
      },
      { command: "isready", responses: ["readyok"] },
      { command: "setoption name Hash value 64" },
      { command: "isready", responses: ["readyok"] },
      { command: "ucinewgame" },
      { command: "setoption name Clear Hash" },
      { command: "isready", responses: ["readyok"] },
      { command: "isready", responses: ["readyok"] },
    ]);
    const client = new UciClient(transport);
    await client.initialize();

    await client.configureOptions([{ name: "Hash", value: 64 }]);
    await client.reset();
    await client.ready();

    expect(transport.commands).toEqual([
      "uci",
      "isready",
      "setoption name Hash value 64",
      "isready",
      "ucinewgame",
      "setoption name Clear Hash",
      "isready",
      "isready",
    ]);
  });

  it("stops and drains an aborted search before permitting the next search", async () => {
    const transport = new MockUciTransport([
      ...initializedSteps(),
      { command: `position fen ${FEN}` },
      {
        command: "go nodes 100",
        responses: ["info depth 1 score cp 5 nodes 1 pv e2e4"],
      },
      { command: "stop", responses: ["bestmove e2e4"] },
      { command: `position fen ${FEN}` },
      {
        command: "go nodes 200",
        responses: [
          "info depth 2 score cp 9 nodes 200 pv d2d4",
          "bestmove d2d4",
        ],
      },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    const controller = new AbortController();
    const aborted = client.evaluateFen(
      FEN,
      { nodes: 100 },
      [],
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();

    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.evaluateFen(FEN, { nodes: 200 })).resolves.toMatchObject({
      bestMove: "d2d4",
      nodes: 200,
    });
    expect(transport.commands).toEqual([
      "uci",
      "isready",
      `position fen ${FEN}`,
      "go nodes 100",
      "stop",
      `position fen ${FEN}`,
      "go nodes 200",
    ]);
    expect(transport.complete).toBe(true);
  });

  it("rejects a signal already aborted without starting a search", async () => {
    const transport = new MockUciTransport(initializedSteps());
    const client = new UciClient(transport);
    await client.initialize();
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.evaluateFen(
        FEN,
        { nodes: 1 },
        [],
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.commands).toEqual(["uci", "isready"]);
  });

  it("rejects use before initialization and concurrent searches", async () => {
    const transport = new MockUciTransport([
      ...initializedSteps(),
      { command: `position fen ${FEN}` },
      {
        command: "go nodes 100",
        responses: ["info depth 1 score cp 0"],
      },
    ]);
    const client = new UciClient(transport, { timeoutMs: 100 });
    await expect(client.evaluateFen(FEN, { depth: 1 })).rejects.toThrow(
      "initialized",
    );
    await client.initialize();
    const pending = client.evaluateFen(FEN, { nodes: 100 });
    await expect(client.evaluateFen(FEN, { nodes: 100 })).rejects.toThrow(
      "Concurrent",
    );
    await expect(pending).rejects.toThrow("Timed out");
  });

  it("fails explicitly if the transport ends before bestmove", async () => {
    const transport = new MockUciTransport([
      ...initializedSteps(),
      { command: `position fen ${FEN}` },
      {
        command: "go depth 2",
        responses: ["info depth 2 score cp 4"],
        closeAfter: true,
      },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    await expect(client.evaluateFen(FEN, { depth: 2 })).rejects.toThrow(
      "ended while waiting for bestmove",
    );
  });

  it("validates commands and closes with quit", async () => {
    const transport = new MockUciTransport([
      ...initializedSteps(),
      { command: "quit", closeAfter: true },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    await client.close();
    await client.close();
    await expect(client.newGame()).rejects.toThrow("closed");
    expect(transport.commands.at(-1)).toBe("quit");
  });
});

describe("UCI parsers", () => {
  it("ignores non-matching lines and rejects malformed scores", () => {
    expect(parseInfo("readyok")).toBeNull();
    expect(parseBestMove("info depth 1")).toBeNull();
    expect(() => parseInfo("info depth 4 score cp nope")).toThrow(
      UciProtocolError,
    );
  });

  it("accepts 0000 as a terminal best move", () => {
    expect(parseBestMove("bestmove 0000")).toEqual({
      bestMove: null,
      ponderMove: null,
    });
  });
});
