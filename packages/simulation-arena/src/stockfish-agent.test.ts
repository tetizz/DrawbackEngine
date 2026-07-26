import { describe, expect, it } from "vitest";
import {
  MockUciTransport,
  UciClient,
} from "@drawbackengine/chess-evaluator";
import {
  cessRule,
  checkersRule,
  type ChessMove,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { asAsyncAgent, simulateGameAsync } from "./async-simulation.js";
import { randomLegalAgent, type AgentView } from "./simulation.js";
import { createStockfishAgent } from "./stockfish-agent.js";

const FEN = "4k3/8/8/8/8/8/8/R3K3 w Q - 0 1";

function chessMove(
  from: string,
  to: string,
  san: string,
  captured?: "pawn" | "knight" | "bishop" | "rook" | "queen" | "king",
): ChessMove {
  return {
    from,
    to,
    color: "white",
    piece: "rook",
    ...(captured === undefined ? {} : { captured }),
    san,
    flags: captured === undefined ? "quiet" : "capture",
  };
}

function handshake() {
  return [
    { command: "uci", responses: ["id name Mockfish", "uciok"] },
    { command: "isready", responses: ["readyok"] },
  ] as const;
}

describe("Stockfish simulation agent", () => {
  it("passes exactly the drawback-legal moves as the UCI root mask", async () => {
    const legalMoves = [
      chessMove("a1", "a2", "Ra2"),
      chessMove("a1", "a8", "Rxa8+", "knight"),
    ];
    const transport = new MockUciTransport([
      ...handshake(),
      { command: `position fen ${FEN}` },
      {
        command: "go depth 8 searchmoves a1a2",
        responses: ["info depth 8 score cp 14 pv a1a2", "bestmove a1a2"],
      },
      { command: "quit", closeAfter: true },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    const agent = createStockfishAgent({ client, limit: { depth: 8 } });
    const view: AgentView = {
      color: "white",
      fen: FEN,
      ply: 0,
      legalMoves: [legalMoves[0] as ChessMove],
      history: [],
    };
    await expect(agent.chooseMove(view, new Mulberry32(1))).resolves.toEqual(
      legalMoves[0],
    );
    expect(transport.commands).toContain("go depth 8 searchmoves a1a2");
    await client.close();
  });

  it("rejects an engine response outside the legal root mask", async () => {
    const transport = new MockUciTransport([
      ...handshake(),
      { command: `position fen ${FEN}` },
      {
        command: "go nodes 10 searchmoves a1a2",
        responses: ["bestmove a1a8"],
      },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    const agent = createStockfishAgent({ client, limit: { nodes: 10 } });
    await expect(
      agent.chooseMove(
        {
          color: "white",
          fen: FEN,
          ply: 0,
          legalMoves: [chessMove("a1", "a2", "Ra2")],
          history: [],
        },
        new Mulberry32(2),
      ),
    ).rejects.toThrow("outside the requested root moves");
  });

  it("runs the asynchronous game path without changing synchronous agents", async () => {
    const initialRootMoves = [
      "a2a3", "a2a4", "b2b3", "b2b4", "c2c3", "c2c4", "d2d3", "d2d4",
      "e2e3", "e2e4", "f2f3", "f2f4", "g2g3", "g2g4", "h2h3", "h2h4",
      "b1a3", "b1c3", "g1f3", "g1h3",
    ];
    const drawbackLegalRootMoves = initialRootMoves.filter(
      (move) => move !== "h2h3" && move !== "h2h4" && move !== "g1h3",
    );
    const startFen =
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const transport = new MockUciTransport([
      ...handshake(),
      { command: `position fen ${startFen}` },
      {
        command: `go depth 4 searchmoves ${drawbackLegalRootMoves.join(" ")}`,
        responses: ["info depth 4 score cp 20 pv e2e4", "bestmove e2e4"],
      },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    const game = await simulateGameAsync({
      seed: 42,
      maxPlies: 1,
      rules: { white: cessRule, black: checkersRule },
      whiteAgent: createStockfishAgent({ client, limit: { depth: 4 } }),
      blackAgent: asAsyncAgent(randomLegalAgent),
    });
    expect(game.plies).toHaveLength(1);
    expect(game.plies[0]?.observation.move.san).toBe("e4");
    expect(game.stoppedAtPlyLimit).toBe(true);
  });

  it("keeps client lifecycle ownership with the caller", async () => {
    const transport = new MockUciTransport([
      ...handshake(),
      { command: "quit", closeAfter: true },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    createStockfishAgent({ client, limit: { depth: 1 } });
    expect(transport.commands).not.toContain("ucinewgame");
    expect(transport.commands).not.toContain("quit");
    await client.close();
    expect(transport.commands.at(-1)).toBe("quit");
  });
});
