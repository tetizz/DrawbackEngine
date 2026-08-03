import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  digestUciOptionDeclarations,
  type NodeUciTurnConstraintProviderConfig,
} from "@drawbackengine/chess-evaluator";

const ENGINE = String.raw`
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
      console.log("id name DrawbackEngine Deterministic Fixture 1");
      console.log("option name Threads type spin default 1 min 1 max 1");
      console.log("option name Hash type spin default 16 min 1 max 128");
      console.log("option name Clear Hash type button");
      console.log("uciok");
    } else if (command === "isready") {
      console.log("readyok");
    } else if (command.startsWith("go ")) {
      const roots = command.split(" searchmoves ")[1].split(" ");
      console.log("info depth 1 nodes 1 score cp 0 pv " + roots[0]);
      console.log("bestmove " + roots[0]);
    } else if (command === "quit") {
      process.exit(0);
    }
  }
});
`;

export const TEST_UCI_CONFIG: NodeUciTurnConstraintProviderConfig = {
  process: {
    executablePath: process.execPath,
    executableSha256: createHash("sha256")
      .update(readFileSync(process.execPath))
      .digest("hex"),
    runtimeContextSha256: "34".repeat(32),
    args: ["-e", ENGINE],
  },
  client: {
    timeoutMs: 5_000,
    options: [
      { name: "Threads", value: 1 },
      { name: "Hash", value: 16 },
    ],
  },
  policy: {
    identity: { id: "stockfish-bestmove-v1", version: 1 },
    engineIdentity: {
      uciName: "DrawbackEngine Deterministic Fixture 1",
      engine: "drawbackengine-fixture",
      version: "1",
    },
    advertisedOptionsSha256: digestUciOptionDeclarations([
      "option name Threads type spin default 1 min 1 max 1",
      "option name Hash type spin default 16 min 1 max 128",
      "option name Clear Hash type button",
    ]),
    optionsDigest: "12".repeat(32),
    limit: { nodes: 1 },
  },
};
