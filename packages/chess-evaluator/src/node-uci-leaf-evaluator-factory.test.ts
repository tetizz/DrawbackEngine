import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LeafPosition } from "@drawbackengine/drawback-search";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestUciOptionDeclarations,
} from "./authenticated-node-uci-engine.js";
import {
  DRAWBACKCHESS_FAIRY_VARIANT_SHA256,
} from "./fairy-stockfish-leaf-evaluator.js";
import {
  createOwnedNodeUciLeafEvaluator,
  deriveNodeUciLeafEvaluatorId,
  type NodeUciLeafEvaluatorConfig,
} from "./node-uci-leaf-evaluator-factory.js";

const FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EXECUTABLE_DIGEST = createHash("sha256")
  .update(await readFile(process.execPath))
  .digest("hex");
const VARIANT_PATH = resolve("data/catalog/drawbackchess-fairy-v1.ini");
const COMMON_OPTION_DECLARATIONS = [
  "option name Threads type spin default 1 min 1 max 1",
  "option name Hash type spin default 16 min 1 max 4096",
  "option name Ponder type check default false",
  "option name MultiPV type spin default 1 min 1 max 500",
  "option name UCI_Chess960 type check default false",
  "option name UCI_LimitStrength type check default false",
  "option name Skill Level type spin default 20 min 0 max 20",
  "option name SyzygyPath type string default <empty>",
  "option name Clear Hash type button",
] as const;
const FAIRY_OPTION_DECLARATIONS = [
  ...COMMON_OPTION_DECLARATIONS,
  "option name VariantPath type string default <empty>",
  "option name UCI_Variant type combo default chess var chess var drawbackchess",
  "option name Use NNUE type check default true",
] as const;
const cleanupPaths: string[] = [];

const ENGINE = String.raw`
const fs = require("node:fs");
const marker = process.argv[1];
const reportedName = process.argv[2];
const kind = process.argv[3];
const mode = process.argv[4];
const commonOptions = [
  "option name Threads type spin default 1 min 1 max 1",
  "option name Hash type spin default 16 min 1 max 4096",
  "option name Ponder type check default false",
  "option name MultiPV type spin default 1 min 1 max 500",
  "option name UCI_Chess960 type check default false",
  "option name UCI_LimitStrength type check default false",
  "option name Skill Level type spin default 20 min 0 max 20",
  "option name SyzygyPath type string default <empty>",
  "option name Clear Hash type button",
];
const fairyOptions = [
  "option name VariantPath type string default <empty>",
  "option name UCI_Variant type combo default chess var chess var drawbackchess",
  "option name Use NNUE type check default true",
];
const commands = [];
let buffer = "";
let chatter = null;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const command = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    commands.push(command);
    if (command === "uci") {
      console.log("id name " + reportedName);
      const options = mode === "missing-option"
        ? commonOptions.filter((line) => !line.includes("MultiPV"))
        : commonOptions;
      for (const option of options) console.log(option);
      if (kind === "fairy-stockfish") {
        const selectedFairyOptions = mode === "missing-fairy-nnue"
          ? fairyOptions.filter((line) => !line.includes("Use NNUE"))
          : fairyOptions;
        for (const option of selectedFairyOptions) console.log(option);
      }
      console.log("uciok");
    } else if (command === "isready") {
      console.log("readyok");
    } else if (command.startsWith("go ")) {
      if (mode === "chatter") {
        chatter = setInterval(() => {
          console.log("info depth 1 nodes 1 score cp 3 pv e2e4");
        }, 1);
      } else {
        const roots = command.split(" searchmoves ")[1].split(" ");
        console.log("info depth 4 nodes 12 score cp 27 pv " + roots[0]);
        console.log("bestmove " + roots[0]);
      }
    } else if (command === "quit") {
      if (chatter !== null) clearInterval(chatter);
      fs.writeFileSync(
        marker,
        JSON.stringify(
          mode === "record-executable"
            ? { commands, executablePath: process.execPath }
            : commands,
        ),
      );
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

function leaf(): LeafPosition {
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
    history: [
      {
        from: "a2",
        to: "a3",
        color: "white",
        piece: "pawn",
        san: "PRIVATE_DRAWBACK_DO_NOT_SEND",
        flags: "quiet",
      },
    ],
    orthodoxCompatible: true,
    kingPassantActive: false,
  };
}

function fixture(
  kind: "stockfish" | "fairy-stockfish" = "stockfish",
  mode = "normal",
): {
  readonly marker: string;
  readonly config: NodeUciLeafEvaluatorConfig;
} {
  const marker = join(tmpdir(), `drawback-leaf-${randomUUID()}.json`);
  cleanupPaths.push(marker);
  const optionDeclarations = kind === "stockfish"
    ? COMMON_OPTION_DECLARATIONS
    : FAIRY_OPTION_DECLARATIONS;
  const base = {
    kind,
    process: {
      executablePath: process.execPath,
      executableSha256: EXECUTABLE_DIGEST,
      args: ["-e", ENGINE, marker, "Pinned Engine 17.1", kind, mode],
      cwd: process.cwd(),
      shutdownTimeoutMs: 2_000,
      runtimeContextSha256: "b".repeat(64),
    },
    client: { timeoutMs: mode === "chatter" ? 1_000 : 2_000 },
    engineIdentity: {
      uciName: "Pinned Engine 17.1",
      engine: kind,
      version: "17.1",
      advertisedOptionsSha256:
        digestUciOptionDeclarations(optionDeclarations),
    },
    depth: 4,
    hashMb: 64,
    unsupportedPosition: "error",
  } as const;
  if (kind === "stockfish") {
    return {
      marker,
      config: {
        ...base,
        kind: "stockfish",
      },
    };
  }
  return {
    marker,
    config: {
      ...base,
      kind: "fairy-stockfish",
      fairyVariant: {
        bytes: new Uint8Array(),
        sha256: DRAWBACKCHESS_FAIRY_VARIANT_SHA256,
      },
    },
  };
}

async function fairyFixture(mode = "normal"): Promise<{
  readonly marker: string;
  readonly config: NodeUciLeafEvaluatorConfig;
}> {
  const prepared = fixture("fairy-stockfish", mode);
  if (prepared.config.kind !== "fairy-stockfish") {
    throw new Error("Expected Fairy fixture.");
  }
  return {
    marker: prepared.marker,
    config: {
      ...prepared.config,
      fairyVariant: {
        bytes: await readFile(VARIANT_PATH),
        sha256: DRAWBACKCHESS_FAIRY_VARIANT_SHA256,
      },
    },
  };
}

describe("createOwnedNodeUciLeafEvaluator", () => {
  it("runs one authenticated Stockfish process with fixed exact options", async () => {
    const { config, marker } = fixture();
    const evaluator = await createOwnedNodeUciLeafEvaluator(config);

    await expect(evaluator.evaluate(leaf())).resolves.toBe(27);
    await expect(evaluator.evaluate({
      ...leaf(),
      orthodoxCompatible: false,
    })).rejects.toThrow("cannot evaluate a non-orthodox");
    expect(evaluator.id).toMatch(
      /^node-uci-leaf\/v1\/[0-9a-f]{64}$/u,
    );
    expect(evaluator.id).not.toContain(config.process.executablePath);
    expect(evaluator.id).not.toContain(marker);
    await evaluator.close();
    await evaluator.close();

    const commands = JSON.parse(
      await readFile(marker, "utf8"),
    ) as unknown;
    expect(commands).toEqual([
      "uci",
      "setoption name Threads value 1",
      "setoption name Hash value 64",
      "setoption name Ponder value false",
      "setoption name MultiPV value 1",
      "setoption name UCI_Chess960 value false",
      "setoption name UCI_LimitStrength value false",
      "setoption name Skill Level value 20",
      "setoption name SyzygyPath value <empty>",
      "setoption name Clear Hash",
      "isready",
      "ucinewgame",
      "setoption name Clear Hash",
      "isready",
      `position fen ${FEN}`,
      "go depth 4 searchmoves d2d4 e2e4",
      "quit",
    ]);
    expect(JSON.stringify(commands)).not.toContain(
      "PRIVATE_DRAWBACK_DO_NOT_SEND",
    );
  });

  it("authenticates optional Fairy bytes and keeps its private path out of the ID", async () => {
    const { config, marker } = await fairyFixture();
    const evaluator = await createOwnedNodeUciLeafEvaluator(config);

    await expect(evaluator.evaluate(leaf())).resolves.toBe(27);
    expect(evaluator.id).toMatch(
      /^node-uci-leaf\/v1\/[0-9a-f]{64}$/u,
    );
    expect(evaluator.id).not.toContain(config.process.executablePath);
    expect(evaluator.id).not.toContain(marker);
    await evaluator.close();

    const commands = JSON.parse(
      await readFile(marker, "utf8"),
    ) as readonly string[];
    const variantCommand = commands.find((command) =>
      command.startsWith("setoption name VariantPath value ")
    );
    expect(variantCommand).toMatch(/[\\/]drawbackchess\.ini$/u);
    expect(evaluator.id).not.toContain(variantCommand ?? "");
    const privateVariantPath = variantCommand?.slice(
      "setoption name VariantPath value ".length,
    );
    if (privateVariantPath === undefined) {
      throw new Error("Missing private Fairy variant path.");
    }
    await expect(readFile(privateVariantPath)).rejects.toThrow();
    expect(commands).toContain(
      "setoption name UCI_Variant value drawbackchess",
    );
    expect(commands).toEqual(expect.arrayContaining([
      "setoption name UCI_LimitStrength value false",
      "setoption name Skill Level value 20",
      "setoption name SyzygyPath value <empty>",
      "setoption name Use NNUE value false",
    ]));
  });

  it("rejects executable, name, and option-surface mismatches and cleans up", async () => {
    const digestMismatch = fixture();
    await expect(createOwnedNodeUciLeafEvaluator({
      ...digestMismatch.config,
      process: {
        ...digestMismatch.config.process,
        executableSha256: "0".repeat(64),
      },
    })).rejects.toThrow("executable SHA-256 mismatch");
    await expect(readFile(digestMismatch.marker)).rejects.toThrow();

    const nameMismatch = fixture();
    await expect(createOwnedNodeUciLeafEvaluator({
      ...nameMismatch.config,
      engineIdentity: {
        ...nameMismatch.config.engineIdentity,
        uciName: "Different Engine 99",
      },
    })).rejects.toThrow("name does not match");
    await expect(readFile(nameMismatch.marker, "utf8")).resolves.toContain(
      "\"quit\"",
    );

    const optionsMismatch = fixture();
    await expect(createOwnedNodeUciLeafEvaluator({
      ...optionsMismatch.config,
      engineIdentity: {
        ...optionsMismatch.config.engineIdentity,
        advertisedOptionsSha256: "0".repeat(64),
      },
    })).rejects.toThrow("option declarations do not match");
    await expect(readFile(optionsMismatch.marker, "utf8")).resolves.toContain(
      "\"quit\"",
    );
  });

  it("spawns the authenticated private copy and removes it after close", async () => {
    const prepared = fixture("stockfish", "record-executable");
    const evaluator = await createOwnedNodeUciLeafEvaluator(
      prepared.config,
    );

    await evaluator.close();
    const recorded = JSON.parse(
      await readFile(prepared.marker, "utf8"),
    ) as {
      readonly commands: readonly string[];
      readonly executablePath: string;
    };
    expect(recorded.commands).toContain("quit");
    expect(recorded.executablePath).not.toBe(process.execPath);
    await expect(readFile(recorded.executablePath)).rejects.toThrow();
  });

  it("removes the authenticated Fairy executable copy after close", async () => {
    const prepared = await fairyFixture("record-executable");
    const evaluator = await createOwnedNodeUciLeafEvaluator(
      prepared.config,
    );

    await evaluator.close();
    const recorded = JSON.parse(
      await readFile(prepared.marker, "utf8"),
    ) as {
      readonly commands: readonly string[];
      readonly executablePath: string;
    };
    expect(recorded.commands).toContain("quit");
    expect(recorded.executablePath).not.toBe(process.execPath);
    await expect(readFile(recorded.executablePath)).rejects.toThrow();
  });

  it("derives host-independent IDs while binding arguments and runtime context", async () => {
    const prepared = fixture();
    const firstId = deriveNodeUciLeafEvaluatorId(prepared.config);
    const privateArgument = "--private-runtime-selector";
    const privateCwd = join(tmpdir(), "private-runtime-cwd");
    const privateExecutable = join(tmpdir(), "private-runtime-engine");
    const changedArgsId = deriveNodeUciLeafEvaluatorId({
      ...prepared.config,
      process: {
        ...prepared.config.process,
        args: [...(prepared.config.process.args ?? []), privateArgument],
      },
    });
    const changedCwdId = deriveNodeUciLeafEvaluatorId({
      ...prepared.config,
      process: {
        ...prepared.config.process,
        cwd: privateCwd,
      },
    });
    const changedExecutableId = deriveNodeUciLeafEvaluatorId({
      ...prepared.config,
      process: {
        ...prepared.config.process,
        executablePath: privateExecutable,
      },
    });
    const changedShutdownId = deriveNodeUciLeafEvaluatorId({
      ...prepared.config,
      process: {
        ...prepared.config.process,
        shutdownTimeoutMs:
          prepared.config.process.shutdownTimeoutMs + 1,
      },
    });
    const changedClientId = deriveNodeUciLeafEvaluatorId({
      ...prepared.config,
      client: {
        timeoutMs: prepared.config.client.timeoutMs + 1,
      },
    });
    const changedRuntimeContextId = deriveNodeUciLeafEvaluatorId({
      ...prepared.config,
      process: {
        ...prepared.config.process,
        runtimeContextSha256: "c".repeat(64),
      },
    });

    expect(changedArgsId).not.toBe(firstId);
    expect(changedCwdId).toBe(firstId);
    expect(changedExecutableId).toBe(firstId);
    expect(changedShutdownId).toBe(firstId);
    expect(changedClientId).toBe(firstId);
    expect(changedRuntimeContextId).not.toBe(firstId);
    for (const id of [
      firstId,
      changedArgsId,
      changedCwdId,
      changedExecutableId,
      changedShutdownId,
      changedClientId,
      changedRuntimeContextId,
    ]) {
      expect(id).toMatch(/^node-uci-leaf\/v1\/[0-9a-f]{64}$/u);
      expect(id).not.toContain(prepared.config.process.executablePath);
      expect(id).not.toContain(prepared.marker);
      expect(id).not.toContain(privateArgument);
      expect(id).not.toContain(privateCwd);
      expect(id).not.toContain(privateExecutable);
    }
    await expect(readFile(prepared.marker)).rejects.toThrow();
  });

  it("requires a caller-pinned runtime context digest", () => {
    const prepared = fixture();
    const invalid = {
      ...prepared.config,
      process: {
        ...prepared.config.process,
        runtimeContextSha256: "not-a-digest",
      },
    } as NodeUciLeafEvaluatorConfig;

    expect(() => deriveNodeUciLeafEvaluatorId(invalid)).toThrow(
      "runtime context SHA-256",
    );
  });

  it("fails closed when a required fixed option is absent", async () => {
    const prepared = fixture("stockfish", "missing-option");
    const missingDeclarations = COMMON_OPTION_DECLARATIONS.filter((line) =>
      !line.includes("MultiPV")
    );

    await expect(createOwnedNodeUciLeafEvaluator({
      ...prepared.config,
      engineIdentity: {
        ...prepared.config.engineIdentity,
        advertisedOptionsSha256:
          digestUciOptionDeclarations(missingDeclarations),
      },
    })).rejects.toThrow(
      "does not advertise required UCI option: MultiPV",
    );
    await expect(readFile(prepared.marker, "utf8")).resolves.toContain(
      "\"quit\"",
    );
  });

  it("fails instead of guessing when Fairy does not advertise Use NNUE", async () => {
    const prepared = await fairyFixture("missing-fairy-nnue");
    if (prepared.config.kind !== "fairy-stockfish") {
      throw new Error("Expected Fairy fixture.");
    }
    const declarationsWithoutNnue = FAIRY_OPTION_DECLARATIONS.filter((line) =>
      !line.includes("Use NNUE")
    );

    await expect(createOwnedNodeUciLeafEvaluator({
      ...prepared.config,
      engineIdentity: {
        ...prepared.config.engineIdentity,
        advertisedOptionsSha256:
          digestUciOptionDeclarations(declarationsWithoutNnue),
      },
    })).rejects.toThrow(
      "does not advertise required UCI option: Use NNUE",
    );
    await expect(readFile(prepared.marker, "utf8")).resolves.toContain(
      "\"quit\"",
    );
  });

  it("uses an absolute timeout, poisons the client, and still closes the process", async () => {
    const { config, marker } = fixture("stockfish", "chatter");
    const evaluator = await createOwnedNodeUciLeafEvaluator(config);

    await expect(evaluator.evaluate(leaf())).rejects.toThrow(
      "Timed out after 1000ms waiting for bestmove",
    );
    await expect(evaluator.evaluate(leaf())).rejects.toThrow("unusable");
    await expect(evaluator.close()).resolves.toBeUndefined();
    await expect(readFile(marker, "utf8")).resolves.toContain("\"quit\"");
  });

  it("authenticates Fairy bytes before spawning and never trusts a measured digest", async () => {
    const prepared = await fairyFixture();
    if (prepared.config.kind !== "fairy-stockfish") {
      throw new Error("Expected Fairy fixture.");
    }
    const changedBytes = new Uint8Array(prepared.config.fairyVariant.bytes);
    changedBytes[0] = (changedBytes[0] ?? 0) ^ 1;

    await expect(createOwnedNodeUciLeafEvaluator({
      ...prepared.config,
      fairyVariant: {
        bytes: changedBytes,
        sha256: DRAWBACKCHESS_FAIRY_VARIANT_SHA256,
      },
    })).rejects.toThrow("do not match the caller-pinned digest");
    await expect(readFile(prepared.marker)).rejects.toThrow();
  });
});
