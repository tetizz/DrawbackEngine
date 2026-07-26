import { describe, expect, it } from "vitest";
import { NodeProcessUciTransport, UciClient } from "./index.js";

const MOCK_ENGINE = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const command = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (command === "uci") {
      console.log("id name Spawned Mock");
      console.log("uciok");
    } else if (command === "isready") {
      console.log("readyok");
    } else if (command.startsWith("go ")) {
      console.log("info depth 2 nodes 10 score cp 7 pv e2e4");
      console.log("bestmove e2e4");
    } else if (command === "quit") {
      process.exit(0);
    }
  }
});
`;

describe("NodeProcessUciTransport", () => {
  it("runs a directly spawned UCI process through handshake, search, and shutdown", async () => {
    const transport = new NodeProcessUciTransport({
      executablePath: process.execPath,
      args: ["-e", MOCK_ENGINE],
    });
    const client = new UciClient(transport, { timeoutMs: 2_000 });

    await expect(client.initialize()).resolves.toMatchObject({
      name: "Spawned Mock",
    });
    await expect(
      client.evaluateFen(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        { depth: 2 },
        ["e2e4"],
      ),
    ).resolves.toMatchObject({
      bestMove: "e2e4",
      score: { kind: "centipawns", value: 7 },
    });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("rejects unsafe multiline commands before writing", async () => {
    const transport = new NodeProcessUciTransport({
      executablePath: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      shutdownTimeoutMs: 100,
    });
    await expect(transport.send("uci\nquit")).rejects.toThrow("single line");
    await expect(transport.close()).rejects.toThrow("did not exit");
  });
});
