import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeUciTurnConstraintProvider } from "./node-turn-constraint-provider-factory.js";

const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const OPTIONS_DIGEST = "a".repeat(64);
const EXECUTABLE_DIGEST = createHash("sha256")
  .update(await readFile(process.execPath))
  .digest("hex");
const cleanupPaths: string[] = [];

const ENGINE = String.raw`
const fs = require("node:fs");
const marker = process.argv[1];
const reportedName = process.argv[2];
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
      console.log("id name " + reportedName);
      console.log("option name Threads type spin default 1 min 1 max 1");
      console.log("option name Clear Hash type button");
      console.log("uciok");
    } else if (command === "isready") {
      console.log("readyok");
    } else if (command.startsWith("go ")) {
      const roots = command.split(" searchmoves ")[1].split(" ");
      console.log("info depth 3 nodes 12 score cp 5 pv " + roots[0]);
      console.log("bestmove " + roots[0]);
    } else if (command === "quit") {
      fs.writeFileSync(marker, "closed");
      process.exit(0);
    }
  }
});
`;

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { force: true })),
  );
});

function config(name = "Factory Mock 1.0") {
  const marker = join(tmpdir(), `drawback-uci-${randomUUID()}.txt`);
  cleanupPaths.push(marker);
  return {
    marker,
    input: {
      process: {
        executablePath: process.execPath,
        executableSha256: EXECUTABLE_DIGEST,
        args: ["-e", ENGINE, marker, "Factory Mock 1.0"],
      },
      client: {
        timeoutMs: 2_000,
        options: [{ name: "Threads", value: 1 }],
      },
      policy: {
        identity: { id: "deterministic-best", version: 1 },
        engineIdentity: {
          uciName: name,
          engine: "factory-mock",
          version: "1.0",
        },
        optionsDigest: OPTIONS_DIGEST,
        limit: { nodes: 12 },
      },
    },
  } as const;
}

describe("createNodeUciTurnConstraintProvider", () => {
  it("initializes a deterministic process provider from serializable input", async () => {
    const { input, marker } = config();
    expect(() => JSON.stringify(input)).not.toThrow();

    const provider = await createNodeUciTurnConstraintProvider(input);
    const roots = ["e2e4", "d2d4"];
    const constraint = await provider.resolve({
      provider: "uci-best-move",
      policyId: "deterministic-best",
      fen: START_FEN,
      ordinaryRootMoves: roots,
      positionKey: JSON.stringify([START_FEN, [...roots].sort()]),
    });
    expect(constraint.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(constraint).toEqual({
      provider: "uci-best-move",
      policyId: "deterministic-best",
      positionKey: JSON.stringify([START_FEN, [...roots].sort()]),
      requestDigest: constraint.requestDigest,
      bestMoveUci: "d2d4",
      engineFingerprint:
        `factory-mock:1.0:${EXECUTABLE_DIGEST}:${OPTIONS_DIGEST}`,
    });

    await provider.dispose();
    await expect(readFile(marker, "utf8")).resolves.toBe("closed");
  });

  it("closes the spawned process when the exact UCI identity mismatches", async () => {
    const { input, marker } = config("Unexpected Engine 9");

    await expect(createNodeUciTurnConstraintProvider(input)).rejects.toThrow(
      "does not match",
    );
    await expect(readFile(marker, "utf8")).resolves.toBe("closed");
  });

  it("closes the spawned process when required option setup fails", async () => {
    const { input, marker } = config();
    const invalid = {
      ...input,
      client: {
        ...input.client,
        options: [{ name: "Missing deterministic option", value: 1 }],
      },
    };

    await expect(createNodeUciTurnConstraintProvider(invalid)).rejects.toThrow(
      "does not advertise",
    );
    await expect(readFile(marker, "utf8")).resolves.toBe("closed");
  });

  it("rejects invalid provenance before spawning a process", async () => {
    const { input } = config();
    await expect(
      createNodeUciTurnConstraintProvider({
        ...input,
        policy: { ...input.policy, optionsDigest: " " },
      }),
    ).rejects.toThrow("options digest");
    for (const engineIdentity of [
      { ...input.policy.engineIdentity, engine: "factory:mock" },
      { ...input.policy.engineIdentity, version: "1:0" },
    ]) {
      await expect(
        createNodeUciTurnConstraintProvider({
          ...input,
          policy: { ...input.policy, engineIdentity },
        }),
      ).rejects.toThrow("fingerprint delimiter");
    }
  });

  it("rejects changed executable bytes before spawning a process", async () => {
    const { input, marker } = config();
    await expect(
      createNodeUciTurnConstraintProvider({
        ...input,
        process: {
          ...input.process,
          executableSha256: "0".repeat(64),
        },
      }),
    ).rejects.toThrow("executable SHA-256 mismatch");
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});
