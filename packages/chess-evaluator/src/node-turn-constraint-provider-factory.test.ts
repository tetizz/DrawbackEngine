import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveUciEvaluationContextDigest,
  digestUciOptionDeclarations,
} from "./authenticated-node-uci-engine.js";
import { createNodeUciTurnConstraintProvider } from "./node-turn-constraint-provider-factory.js";

const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const OPTIONS_DIGEST = "a".repeat(64);
const RUNTIME_CONTEXT_DIGEST = "b".repeat(64);
const ADVERTISED_OPTIONS_DIGEST = digestUciOptionDeclarations([
  "option name Threads type spin default 1 min 1 max 1",
  "option name Clear Hash type button",
]);
const DETERMINISTIC_STOCKFISH_OPTIONS = [
  { name: "Threads", value: 1 },
  { name: "Hash", value: 16 },
  { name: "Ponder", value: false },
  { name: "MultiPV", value: 1 },
  { name: "UCI_Chess960", value: false },
  { name: "UCI_LimitStrength", value: false },
  { name: "Skill Level", value: 20 },
  { name: "SyzygyPath", value: "<empty>" },
  { name: "Clear Hash" },
] as const;
const EXECUTABLE_DIGEST = createHash("sha256")
  .update(await readFile(process.execPath))
  .digest("hex");
const cleanupPaths: string[] = [];

const ENGINE = String.raw`
const fs = require("node:fs");
const marker = process.argv[1];
const reportedName = process.argv[2];
fs.writeFileSync(marker + ".executable", process.execPath);
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
  const executableMarker = `${marker}.executable`;
  cleanupPaths.push(marker, executableMarker);
  return {
    marker,
    executableMarker,
    input: {
      process: {
        executablePath: process.execPath,
        executableSha256: EXECUTABLE_DIGEST,
        runtimeContextSha256: RUNTIME_CONTEXT_DIGEST,
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
        advertisedOptionsSha256: ADVERTISED_OPTIONS_DIGEST,
        optionsDigest: OPTIONS_DIGEST,
        limit: { nodes: 12 },
      },
    },
  } as const;
}

describe("createNodeUciTurnConstraintProvider", () => {
  it("binds executable, arguments, runtime assets, and options", () => {
    const baseInput = {
      optionsDigest: "1".repeat(64),
      runtimeContextSha256: "2".repeat(64),
      executableSha256: "3".repeat(64),
      processArgs: ["--mode", "one"],
      configuredOptions: [{ name: "Threads", value: 1 }],
      advertisedOptionsSha256: "4".repeat(64),
    } as const;
    const base = deriveUciEvaluationContextDigest(baseInput);
    const variants = [
      deriveUciEvaluationContextDigest({
        ...baseInput,
        optionsDigest: "5".repeat(64),
      }),
      deriveUciEvaluationContextDigest({
        ...baseInput,
        runtimeContextSha256: "6".repeat(64),
      }),
      deriveUciEvaluationContextDigest({
        ...baseInput,
        executableSha256: "7".repeat(64),
      }),
      deriveUciEvaluationContextDigest({
        ...baseInput,
        processArgs: ["--mode", "two"],
      }),
      deriveUciEvaluationContextDigest({
        ...baseInput,
        configuredOptions: [{ name: "Threads", value: 8 }],
      }),
      deriveUciEvaluationContextDigest({
        ...baseInput,
        advertisedOptionsSha256: "8".repeat(64),
      }),
    ];

    expect(new Set(variants)).toHaveLength(6);
    expect(variants).not.toContain(base);
  });

  it("initializes a deterministic process provider from serializable input", async () => {
    const { input, marker, executableMarker } = config();
    const evaluationContextDigest = deriveUciEvaluationContextDigest({
      optionsDigest: OPTIONS_DIGEST,
      runtimeContextSha256: RUNTIME_CONTEXT_DIGEST,
      executableSha256: EXECUTABLE_DIGEST,
      processArgs: input.process.args,
      configuredOptions: input.client.options,
      advertisedOptionsSha256: ADVERTISED_OPTIONS_DIGEST,
    });
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
        `factory-mock:1.0:${EXECUTABLE_DIGEST}:${evaluationContextDigest}`,
    });

    await provider.dispose();
    await expect(readFile(marker, "utf8")).resolves.toBe("closed");
    const stagedExecutable = await readFile(executableMarker, "utf8");
    expect(stagedExecutable).not.toBe(process.execPath);
    await expect(readFile(stagedExecutable)).rejects.toThrow();
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
    await expect(
      createNodeUciTurnConstraintProvider({
        ...input,
        process: { ...input.process, runtimeContextSha256: " " },
      }),
    ).rejects.toThrow("runtime context SHA-256");
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

  it("rejects depth and wall-clock limits before spawning", async () => {
    for (const limit of [{ depth: 3 }, { moveTimeMs: 50 }] as const) {
      const { input, marker } = config();
      await expect(createNodeUciTurnConstraintProvider({
        ...input,
        policy: { ...input.policy, limit },
      })).rejects.toThrow("fixed node search limit");
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    }
  });

  it("rejects nondeterministic Stockfish settings before spawning", async () => {
    const invalidManifests = [
      DETERMINISTIC_STOCKFISH_OPTIONS.map((option) =>
        option.name === "Threads"
          ? { name: "Threads", value: 8 }
          : option
      ),
      DETERMINISTIC_STOCKFISH_OPTIONS.map((option) =>
        option.name === "Ponder"
          ? { name: "Ponder", value: true }
          : option
      ),
      DETERMINISTIC_STOCKFISH_OPTIONS.filter(
        (option) => option.name !== "Clear Hash",
      ),
    ];
    for (const options of invalidManifests) {
      const { input, marker } = config();
      await expect(createNodeUciTurnConstraintProvider({
        ...input,
        client: { ...input.client, options },
        policy: {
          ...input.policy,
          engineIdentity: {
            ...input.policy.engineIdentity,
            engine: "stockfish",
          },
        },
      })).rejects.toThrow("Deterministic Stockfish policy requires");
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    }
  });

  it("rejects case-variant duplicate Stockfish options before spawning", async () => {
    const { input, marker } = config();
    await expect(createNodeUciTurnConstraintProvider({
      ...input,
      client: {
        ...input.client,
        options: [
          ...DETERMINISTIC_STOCKFISH_OPTIONS,
          { name: "threads", value: 2 },
        ],
      },
      policy: {
        ...input.policy,
        engineIdentity: {
          ...input.policy.engineIdentity,
          engine: "stockfish",
        },
      },
    })).rejects.toThrow("Duplicate deterministic UCI option threads");
    await expect(readFile(marker, "utf8")).rejects.toThrow();
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
