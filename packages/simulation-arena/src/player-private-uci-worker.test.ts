import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveNodeUciLeafEvaluatorId,
  digestUciOptionDeclarations,
  type NodeStockfishLeafEvaluatorConfig,
} from "@drawbackengine/chess-evaluator";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlayerPrivateAssignmentSchedule,
} from "./player-private-assignment-scheduler.js";
import type {
  IndexedPlayerPrivateAssignment,
  PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";
import {
  createPlayerPrivateWorkerPool,
  PlayerPrivateWorkerPoolCleanupError,
} from "./player-private-worker-pool.js";
import {
  streamPlayerPrivateAssignmentsParallel,
} from "./player-private-stream.js";
import {
  createNodePlayerPrivateWorker,
} from "./player-private-worker-transport.js";
import type {
  PlayerPrivateWorkerInitialization,
} from "./player-private-worker-protocol.js";
import type {
  PlayerPrivateWorkerFactory,
  PlayerPrivateWorkerTransportHandlers,
} from "./player-private-worker-transport.js";

const EXECUTABLE_SHA256 = createHash("sha256")
  .update(await readFile(process.execPath))
  .digest("hex");
const OPTION_DECLARATIONS = [
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
const MOCK_ENGINE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const logDirectory = process.argv[1];
const mode = process.argv[2];
const crashMarker = path.join(logDirectory, "crash-once.marker");
fs.writeFileSync(
  path.join(logDirectory, "started-" + process.pid + ".json"),
  JSON.stringify({ executablePath: process.execPath }),
);
const commands = [];
let buffer = "";
let pendingRoot = null;
let pendingDepth = null;
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
      console.log("id name Drawback Worker Test");
      for (const option of ${JSON.stringify(OPTION_DECLARATIONS)}) {
        console.log(option);
      }
      console.log("uciok");
    } else if (command === "isready") {
      console.log("readyok");
    } else if (command.startsWith("go ")) {
      if (mode === "crash-once" || mode === "clean-exit-once") {
        try {
          fs.writeFileSync(crashMarker, "claimed", { flag: "wx" });
          process.exit(mode === "clean-exit-once" ? 0 : 17);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      const roots = command.split(" searchmoves ")[1].split(" ");
      const depth = command.match(/^go depth ([0-9]+)/)[1];
      pendingRoot = roots[0];
      pendingDepth = depth;
      fs.writeFileSync(
        path.join(logDirectory, "go-" + process.pid + ".marker"),
        "started",
      );
      if (mode === "hold-search") continue;
      console.log(
        "info depth " + depth + " nodes 10 score cp 0 pv " + roots[0],
      );
      console.log("bestmove " + roots[0]);
    } else if (command === "stop") {
      console.log(
        "info depth " + pendingDepth + " nodes 10 score cp 0 pv " + pendingRoot,
      );
      console.log("bestmove " + pendingRoot);
    } else if (command === "quit") {
      fs.writeFileSync(
        path.join(logDirectory, "engine-" + process.pid + ".json"),
        JSON.stringify({ commands, executablePath: process.execPath }),
      );
      process.exit(0);
    }
  }
});
`;

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("authenticated UCI player-private workers", () => {
  it("keeps one authenticated UCI process alive across pool batches", async () => {
    const directory = await temporaryDirectory();
    const policy = uciPolicy(directory, "normal");
    let workerInitialization: PlayerPrivateWorkerInitialization | undefined;
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      initializationTimeoutMs: 10_000,
      workerFactory: (request) => {
        workerInitialization = request.workerData;
        return createNodePlayerPrivateWorker(request);
      },
    });
    try {
      expect(workerInitialization?.policy.evaluator).toEqual({
        kind: "node-uci-leaf",
        version: 1,
        evaluatorId: policy.evaluator.kind === "node-uci-leaf"
          ? policy.evaluator.evaluatorId
          : "",
      });
      expect(JSON.stringify(workerInitialization)).not.toContain(directory);
      expect(JSON.stringify(workerInitialization)).not.toContain("config");
      const first = await pool.runBatch([assignment(0, 91_001)]);
      const second = await pool.runBatch([assignment(1, 91_002)]);
      expect(first[0]?.result.agents.white.searchPolicy?.evaluatorId).toBe(
        policy.evaluator.kind === "node-uci-leaf"
          ? policy.evaluator.evaluatorId
          : "",
      );
      expect(second[0]?.result.agents.white.searchPolicy?.evaluatorId).toBe(
        first[0]?.result.agents.white.searchPolicy?.evaluatorId,
      );
      expect(pool.diagnostics()).toMatchObject({
        launches: 1,
        activeWorkers: 1,
        completedTasks: 2,
      });
    } finally {
      await pool.close();
    }

    const logs = await engineLogs(directory);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.commands.filter((command) => command === "uci")).toEqual(
      ["uci"],
    );
    expect(
      logs[0]?.commands.filter((command) => command.startsWith("go depth ")),
    ).not.toHaveLength(0);
    expect(logs[0]?.commands.at(-1)).toBe("quit");
    expect(logs[0]?.executablePath).not.toBe(process.execPath);
    await expect(readFile(logs[0]?.executablePath ?? "")).rejects.toThrow();
  }, 30_000);

  it.each([
    "crash-once",
    "clean-exit-once",
  ] as const)(
    "retries an unchanged game after typed UCI process failure %s",
    async (mode) => {
      const directory = await temporaryDirectory();
      const policy = uciPolicy(directory, mode);
      const marker = join(directory, "crash-once.marker");
      await writeFile(marker, "preclaimed", "utf8");
      const baselinePool = await createPlayerPrivateWorkerPool({
        workers: 1,
        policy,
        maxPlies: 1,
        initializationTimeoutMs: 10_000,
      });
      const baseline = await baselinePool.runBatch([
        assignment(0, 92_001),
      ]);
      await baselinePool.close();
      await rm(marker, { force: true });

      const retryPool = await createPlayerPrivateWorkerPool({
        workers: 1,
        policy,
        maxPlies: 1,
        initializationTimeoutMs: 10_000,
      });
      try {
        const retried = await retryPool.runBatch([
          assignment(0, 92_001),
        ]);
        expect(retried).toEqual(baseline);
        expect(JSON.stringify(retried)).toBe(JSON.stringify(baseline));
        expect(retryPool.diagnostics()).toMatchObject({
          launches: 2,
          completedTasks: 1,
          retriedTasks: 1,
        });
      } finally {
        await retryPool.close();
      }
      const stagedExecutables = await startedExecutables(directory);
      expect(stagedExecutables.length).toBeGreaterThanOrEqual(3);
      for (const executablePath of stagedExecutables) {
        expect(executablePath).not.toBe(process.execPath);
        await expect(readFile(executablePath)).rejects.toThrow();
      }
    },
    45_000,
  );

  it("aborts active search and removes staged executables on pool shutdown", async () => {
    const directory = await temporaryDirectory();
    const policy = uciPolicy(directory, "hold-search");
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      initializationTimeoutMs: 10_000,
    });
    const pending = pool.runBatch([assignment(0, 93_001)]);
    const cancelled = expect(pending).rejects.toThrow(
      "cancelled by shutdown",
    );
    await waitForFile(directory, /^go-[0-9]+\.marker$/u);

    await expect(pool.close()).resolves.toBeUndefined();
    await cancelled;
    for (const executablePath of await startedExecutables(directory)) {
      await expect(readFile(executablePath)).rejects.toThrow();
    }
    const logs = await engineLogs(directory);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.commands).toContain("stop");
    expect(logs[0]?.commands.at(-1)).toBe("quit");
  }, 30_000);

  it("aborts a process-backed stream without leaving staged executables", async () => {
    const directory = await temporaryDirectory();
    const policy = uciPolicy(directory, "hold-search");
    const controller = new AbortController();
    const iterator = streamPlayerPrivateAssignmentsParallel({
      assignments: createPlayerPrivateAssignmentSchedule({
        splitCounts: { train: 1, validation: 0, test: 0 },
        labelSeed: 94_001,
        gameplaySeed: 94_002,
        parameterSeed: 94_003,
      }),
      workers: 1,
      windowSize: 1,
      policy,
      maxPlies: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await waitForFile(directory, /^go-[0-9]+\.marker$/u);

    controller.abort(new Error("Synthetic process-backed stream abort."));

    const failure = await pending.catch((error: unknown) => error);
    expect(allErrorMessages(failure)).toContain(
      "Synthetic process-backed stream abort.",
    );
    for (const executablePath of await startedExecutables(directory)) {
      await expect(readFile(executablePath)).rejects.toThrow();
    }
    const logs = await engineLogs(directory);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.commands).toContain("stop");
    expect(logs[0]?.commands.at(-1)).toBe("quit");
  }, 30_000);

  it("removes the parent-owned engine when worker initialization times out", async () => {
    const directory = await temporaryDirectory();
    const policy = uciPolicy(directory, "normal");
    const harness = lifecycleWorkerFactory("never-ready");

    await expect(createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      attempts: 1,
      initializationTimeoutMs: 25,
      shutdownTimeoutMs: 50,
      workerFactory: harness.factory,
    })).rejects.toThrow("did not authenticate readiness");

    expect(harness.active()).toBe(0);
    expect(harness.terminateCalls()).toBe(1);
    const executables = await startedExecutables(directory);
    expect(executables).toHaveLength(1);
    for (const executablePath of executables) {
      await expect(readFile(executablePath)).rejects.toThrow();
    }
    expect((await engineLogs(directory))[0]?.commands.at(-1)).toBe("quit");
  }, 30_000);

  it("force-stops an unresponsive worker without orphaning its engine", async () => {
    const directory = await temporaryDirectory();
    const policy = uciPolicy(directory, "normal");
    const harness = lifecycleWorkerFactory("ignore-shutdown");
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      attempts: 1,
      initializationTimeoutMs: 2_000,
      shutdownTimeoutMs: 25,
      workerFactory: harness.factory,
    });

    const cleanupFailure = await pool.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    expect(cleanupFailure).not.toBeInstanceOf(
      PlayerPrivateWorkerPoolCleanupError,
    );
    expect(cleanupFailure).toMatchObject({
      message: "Player-private worker pool cleanup completed abnormally.",
    });
    expect(harness.active()).toBe(0);
    expect(harness.terminateCalls()).toBe(1);
    const executables = await startedExecutables(directory);
    expect(executables).toHaveLength(1);
    for (const executablePath of executables) {
      await expect(readFile(executablePath)).rejects.toThrow();
    }
    expect((await engineLogs(directory))[0]?.commands.at(-1)).toBe("quit");
  }, 30_000);
});

function uciPolicy(
  logDirectory: string,
  mode:
    | "normal"
    | "crash-once"
    | "clean-exit-once"
    | "hold-search",
): PlayerPrivateSearchPolicy {
  const config: NodeStockfishLeafEvaluatorConfig = {
    kind: "stockfish",
    process: {
      executablePath: process.execPath,
      executableSha256: EXECUTABLE_SHA256,
      args: ["-e", MOCK_ENGINE, logDirectory, mode],
      cwd: process.cwd(),
      shutdownTimeoutMs: 2_000,
      runtimeContextSha256: "b".repeat(64),
    },
    client: { timeoutMs: 5_000 },
    engineIdentity: {
      uciName: "Drawback Worker Test",
      engine: "stockfish",
      version: "test-v1",
      advertisedOptionsSha256:
        digestUciOptionDeclarations(OPTION_DECLARATIONS),
    },
    depth: 2,
    hashMb: 16,
    unsupportedPosition: "error",
  };
  return {
    policyId: "authenticated-uci-worker-test",
    maxDepth: 1,
    maxNodes: 2_000,
    temperatureCp: 35,
    evaluator: {
      kind: "node-uci-leaf",
      version: 1,
      evaluatorId: deriveNodeUciLeafEvaluatorId(config),
      config,
    },
    opponentHypotheses: {
      kind: "unrestricted-baseline",
      version: 1,
    },
  };
}

function assignment(
  gameIndex: number,
  seed: number,
): IndexedPlayerPrivateAssignment {
  return {
    gameIndex,
    assignment: {
      seed,
      parameterSeeds: {
        white: (seed + 1_000) >>> 0,
        black: (seed + 2_000) >>> 0,
      },
      whiteRuleId: "vegan",
      blackRuleId: "checkers",
    },
  };
}

function lifecycleWorkerFactory(
  mode: "never-ready" | "ignore-shutdown",
): {
  readonly factory: PlayerPrivateWorkerFactory;
  readonly active: () => number;
  readonly terminateCalls: () => number;
} {
  let active = 0;
  let terminateCalls = 0;
  const factory: PlayerPrivateWorkerFactory = (request) => {
    active += 1;
    let handlers: PlayerPrivateWorkerTransportHandlers | undefined;
    let terminated = false;
    return {
      postMessage(): void {
        // Both modes intentionally ignore parent shutdown requests.
      },
      subscribe(nextHandlers): () => void {
        handlers = nextHandlers;
        if (mode === "ignore-shutdown") {
          queueMicrotask(() => {
            if (terminated) {
              return;
            }
            nextHandlers.message({
              schemaVersion: 2,
              kind: "player-private-worker-ready",
              poolId: request.workerData.poolId,
              workerId: request.workerData.workerId,
              generation: request.workerData.generation,
              authenticationToken: request.workerData.authenticationToken,
              evaluatorId:
                request.workerData.policy.evaluator.kind === "material"
                  ? "drawback-material/v1"
                  : request.workerData.policy.evaluator.evaluatorId,
            });
          });
        }
        return () => {
          handlers = undefined;
        };
      },
      terminate(): Promise<number> {
        terminateCalls += 1;
        if (!terminated) {
          terminated = true;
          active -= 1;
          const exit = handlers?.exit;
          queueMicrotask(() => exit?.(1));
        }
        return Promise.resolve(1);
      },
    };
  };
  return {
    factory,
    active: () => active,
    terminateCalls: () => terminateCalls,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), `drawback-worker-${randomUUID()}-`),
  );
  cleanupDirectories.push(directory);
  return directory;
}

async function engineLogs(directory: string): Promise<readonly {
  readonly commands: readonly string[];
  readonly executablePath: string;
}[]> {
  const names = (await readdir(directory))
    .filter((name) => /^engine-[0-9]+\.json$/u.test(name))
    .sort();
  return Promise.all(names.map(async (name) =>
    JSON.parse(await readFile(join(directory, name), "utf8")) as {
      readonly commands: readonly string[];
      readonly executablePath: string;
    }
  ));
}

async function startedExecutables(
  directory: string,
): Promise<readonly string[]> {
  const names = (await readdir(directory))
    .filter((name) => /^started-[0-9]+\.json$/u.test(name))
    .sort();
  return Promise.all(names.map(async (name) => {
    const value = JSON.parse(
      await readFile(join(directory, name), "utf8"),
    ) as { readonly executablePath: string };
    return value.executablePath;
  }));
}

async function waitForFile(
  directory: string,
  pattern: RegExp,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await readdir(directory)).some((name) => pattern.test(name))) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("Timed out waiting for the mock UCI search to start.");
}

function allErrorMessages(value: unknown): readonly string[] {
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause !== undefined) {
        pending.push(current.cause);
      }
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors as readonly unknown[]);
    }
  }
  return messages;
}
