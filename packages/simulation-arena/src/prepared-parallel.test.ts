import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthenticatedNodeUciEngineCloseError,
  type NodeUciTurnConstraintProviderConfig,
  type UciTurnConstraintProvider,
} from "@drawbackengine/chess-evaluator";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogAgentId } from "./catalog.js";
import {
  PreparedEvaluatorCleanupError,
  simulatePreparedCatalogAssignmentsParallel,
  simulatePreparedCatalogSeedsParallel,
} from "./parallel.js";
import type {
  PreparedCatalogGameAssignment,
  PreparedExecutableRuleId,
} from "./prepared-catalog.js";
import { TEST_UCI_CONFIG } from "./test-uci-config.js";

type MutablePreparedAssignment = {
  -readonly [Key in keyof PreparedCatalogGameAssignment]:
    PreparedCatalogGameAssignment[Key];
};

const MARK_LAUNCH_ENGINE = String.raw`
require("node:fs").writeFileSync(process.argv[1], "launched");
setInterval(() => undefined, 60_000);
`;

const IGNORE_QUIT_ENGINE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const directory = process.argv[1];
fs.writeFileSync(
  path.join(directory, "started-" + process.pid + ".txt"),
  process.execPath,
);
setInterval(() => undefined, 60_000);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const command = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (command === "uci") {
      console.log("id name Prepared Cleanup Fixture");
      console.log("option name Threads type spin default 1 min 1 max 1");
      console.log("option name Hash type spin default 16 min 1 max 128");
      console.log("option name Clear Hash type button");
      console.log("uciok");
    } else if (command === "isready") {
      console.log("readyok");
    } else if (command.startsWith("go ")) {
      const roots = command.split(" searchmoves ")[1].split(" ");
      fs.writeFileSync(
        path.join(directory, "search-" + process.pid + ".txt"),
        roots[0],
      );
      console.log("info depth 1 nodes 1 score cp 0 pv " + roots[0]);
      console.log("bestmove " + roots[0]);
    } else if (command === "quit") {
      fs.writeFileSync(
        path.join(directory, "quit-" + process.pid + ".txt"),
        "ignored",
      );
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

function serialized(
  games: Awaited<ReturnType<typeof simulatePreparedCatalogSeedsParallel>>,
): string {
  return JSON.stringify(games);
}

describe("prepared parallel simulation", () => {
  it("is byte-identical across worker counts with uniform evaluator facts", async () => {
    const request = {
      seeds: [101, 102, 103, 104],
      maxPlies: 3,
      ruleIds: [
        "vegan",
        "hand-and-gigabrain",
        "ichtyophobe",
      ],
      agentIds: ["random-legal"],
      evaluator: TEST_UCI_CONFIG,
    } as const;

    const oneWorker = await simulatePreparedCatalogSeedsParallel({
      ...request,
      workers: 1,
    });
    const twoWorkers = await simulatePreparedCatalogSeedsParallel({
      ...request,
      workers: 2,
    });

    expect(twoWorkers).toEqual(oneWorker);
    expect(serialized(twoWorkers)).toBe(serialized(oneWorker));
    expect(
      oneWorker.every((game) =>
        game.plies.every(
          (ply) => ply.observation.externalConstraint !== undefined,
        ),
      ),
    ).toBe(true);
  }, 30_000);

  it("preserves explicit assignments across worker counts", async () => {
    const request = {
      assignments: [
        {
          seed: 201,
          whiteRuleId: "hand-and-gigabrain",
          blackRuleId: "vegan",
          whiteAgentId: "random-legal",
          blackAgentId: "greedy-material",
        },
        {
          seed: 202,
          whiteRuleId: "vegan",
          blackRuleId: "ichtyophobe",
          whiteAgentId: "greedy-material",
          blackAgentId: "random-legal",
        },
      ],
      maxPlies: 2,
      evaluator: TEST_UCI_CONFIG,
    } as const;
    const serial = await simulatePreparedCatalogAssignmentsParallel({
      ...request,
      workers: 1,
    });
    const parallel = await simulatePreparedCatalogAssignmentsParallel({
      ...request,
      workers: 2,
    });

    expect(parallel).toEqual(serial);
    expect(serialized(parallel)).toBe(serialized(serial));
    expect(parallel.map((game) => game.drawbacks)).toEqual([
      { white: "hand-and-gigabrain", black: "vegan" },
      { white: "vegan", black: "ichtyophobe" },
    ]);
  }, 30_000);

  it("snapshots mutable seed, rule, and agent selections before awaiting", async () => {
    const seeds = [301];
    const ruleIds: PreparedExecutableRuleId[] = ["vegan"];
    const agentIds: CatalogAgentId[] = ["random-legal"];
    const pending = simulatePreparedCatalogSeedsParallel({
      seeds,
      workers: 1,
      ruleIds,
      agentIds,
      maxPlies: 1,
      evaluator: TEST_UCI_CONFIG,
    });

    seeds[0] = 999;
    seeds.push(1_000);
    ruleIds[0] = "hand-and-gigabrain";
    agentIds[0] = "greedy-material";

    const games = await pending;
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      seed: 301,
      drawbacks: { white: "vegan", black: "vegan" },
      agents: {
        white: { id: "random-legal" },
        black: { id: "random-legal" },
      },
    });
  }, 30_000);

  it("snapshots mutable assignment arrays and records before awaiting", async () => {
    const original: MutablePreparedAssignment = {
      seed: 401,
      whiteRuleId: "vegan",
      blackRuleId: "checkers",
      whiteAgentId: "random-legal",
      blackAgentId: "greedy-material",
    };
    const assignments: MutablePreparedAssignment[] = [original];
    const pending = simulatePreparedCatalogAssignmentsParallel({
      assignments,
      workers: 1,
      maxPlies: 1,
      evaluator: TEST_UCI_CONFIG,
    });

    original.seed = 999;
    original.whiteRuleId = "hand-and-gigabrain";
    original.blackRuleId = "ichtyophobe";
    original.whiteAgentId = "greedy-material";
    original.blackAgentId = "random-legal";
    assignments.push({ ...original, seed: 1_000 });

    const games = await pending;
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      seed: 401,
      drawbacks: { white: "vegan", black: "checkers" },
      agents: {
        white: { id: "random-legal" },
        black: { id: "greedy-material" },
      },
    });
  }, 30_000);

  it("rejects invalid selections before the evaluator can launch", async () => {
    const invalidRule = "outside-rule" as PreparedExecutableRuleId;
    const invalidAgent = "outside-agent" as CatalogAgentId;
    const cases = [
      {
        expected: "prepared rule selection is outside the catalog",
        invoke: (evaluator: NodeUciTurnConstraintProviderConfig) =>
          simulatePreparedCatalogSeedsParallel({
            seeds: [501],
            workers: 1,
            ruleIds: [invalidRule],
            agentIds: ["random-legal"],
            maxPlies: 1,
            evaluator,
          }),
      },
      {
        expected: "prepared agent selection is outside the catalog",
        invoke: (evaluator: NodeUciTurnConstraintProviderConfig) =>
          simulatePreparedCatalogSeedsParallel({
            seeds: [502],
            workers: 1,
            ruleIds: ["vegan"],
            agentIds: [invalidAgent],
            maxPlies: 1,
            evaluator,
          }),
      },
      {
        expected: "maxPlies must be a positive safe integer",
        invoke: (evaluator: NodeUciTurnConstraintProviderConfig) =>
          simulatePreparedCatalogSeedsParallel({
            seeds: [503],
            workers: 1,
            ruleIds: ["vegan"],
            agentIds: ["random-legal"],
            maxPlies: 0,
            evaluator,
          }),
      },
    ] as const;

    for (const testCase of cases) {
      const directory = await temporaryDirectory();
      const marker = join(directory, "launched.txt");
      await expect(
        testCase.invoke(markLaunchEvaluator(marker)),
      ).rejects.toThrow(testCase.expected);
      await expect(access(marker)).rejects.toThrow();
    }
  });

  it("settles every shard and surfaces complete abnormal cleanup", async () => {
    const directory = await temporaryDirectory();
    let failure: unknown;
    try {
      await simulatePreparedCatalogSeedsParallel({
        seeds: [601, 602],
        workers: 2,
        ruleIds: ["hand-and-gigabrain"],
        agentIds: ["random-legal"],
        maxPlies: 1,
        evaluator: ignoreQuitEvaluator(directory),
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("Expected both prepared shards to fail cleanup.");
    }
    const shardFailures: readonly unknown[] = failure.errors;
    expect(shardFailures).toHaveLength(2);
    for (const shardFailure of shardFailures) {
      expect(shardFailure).toBeInstanceOf(
        AuthenticatedNodeUciEngineCloseError,
      );
      expect(shardFailure).toMatchObject({
        privateExecutableRemoved: true,
        processTerminated: true,
      });
    }

    const entries = await readdir(directory);
    const started = entries.filter((entry) => entry.startsWith("started-"));
    const searches = entries.filter((entry) => entry.startsWith("search-"));
    const ignoredQuits = entries.filter((entry) => entry.startsWith("quit-"));
    expect(started).toHaveLength(2);
    expect(searches).toHaveLength(2);
    expect(ignoredQuits).toHaveLength(2);
    for (const entry of started) {
      const stagedExecutable = await readFile(
        join(directory, entry),
        "utf8",
      );
      expect(stagedExecutable).not.toBe(process.execPath);
      await expect(access(stagedExecutable)).rejects.toThrow();
    }
  }, 30_000);

  it("retains the same provider after bounded cleanup remains unproven", async () => {
    let cleanupAllowed = false;
    const dispose = vi.fn(() =>
      cleanupAllowed
        ? Promise.resolve()
        : Promise.reject(new Error("cleanup remains unproven"))
    );
    const provider = {
      dispose,
    } as unknown as UciTurnConstraintProvider;
    const retained = new PreparedEvaluatorCleanupError(
      [new Error("earlier cleanup failure")],
      provider,
    );

    const retried = await retained.retryCleanup().catch(
      (error: unknown) => error,
    );
    expect(retried).toBeInstanceOf(PreparedEvaluatorCleanupError);
    expect(dispose).toHaveBeenCalledTimes(2);
    if (!(retried instanceof PreparedEvaluatorCleanupError)) {
      throw new Error("Expected retained prepared evaluator ownership.");
    }
    expect(retried.errors).toHaveLength(3);

    cleanupAllowed = true;
    await expect(retried.retryCleanup()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "prepared-parallel-test-"));
  cleanupDirectories.push(directory);
  return directory;
}

function markLaunchEvaluator(
  marker: string,
): NodeUciTurnConstraintProviderConfig {
  return {
    ...TEST_UCI_CONFIG,
    process: {
      ...TEST_UCI_CONFIG.process,
      args: ["-e", MARK_LAUNCH_ENGINE, marker],
      shutdownTimeoutMs: 50,
    },
    client: {
      ...TEST_UCI_CONFIG.client,
      timeoutMs: 100,
    },
  };
}

function ignoreQuitEvaluator(
  directory: string,
): NodeUciTurnConstraintProviderConfig {
  return {
    ...TEST_UCI_CONFIG,
    process: {
      ...TEST_UCI_CONFIG.process,
      args: ["-e", IGNORE_QUIT_ENGINE, directory],
      shutdownTimeoutMs: 50,
    },
    client: {
      ...TEST_UCI_CONFIG.client,
      timeoutMs: 2_000,
    },
    policy: {
      ...TEST_UCI_CONFIG.policy,
      engineIdentity: {
        uciName: "Prepared Cleanup Fixture",
        engine: "prepared-cleanup-fixture",
        version: "1",
      },
    },
  };
}
