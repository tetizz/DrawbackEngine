import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  protocolRecord,
  type IndexedPlayerPrivateAssignment,
  type PlayerPrivateGameAssignment,
  type PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";
import {
  assertPlayerPrivateWorkerShutdown,
  assertPlayerPrivateWorkerTask,
  type PlayerPrivateWorkerIdentity,
  type PlayerPrivateWorkerReady,
  type PlayerPrivateWorkerStopped,
  type PlayerPrivateWorkerTask,
  type PlayerPrivateWorkerTaskFailure,
  type PlayerPrivateWorkerTaskResult,
} from "./player-private-worker-protocol.js";
import {
  simulatePlayerPrivateAssignmentsParallel,
} from "./player-private-parallel.js";
import type {
  PlayerPrivateSimulationResult,
} from "./player-private-simulation.js";
import {
  createPlayerPrivateWorkerPool,
} from "./player-private-worker-pool.js";
import type {
  PlayerPrivateWorkerFactory,
  PlayerPrivateWorkerFactoryRequest,
  PlayerPrivateWorkerTransport,
  PlayerPrivateWorkerTransportHandlers,
} from "./player-private-worker-transport.js";

const policy: PlayerPrivateSearchPolicy = {
  policyId: "persistent-worker-pool-test",
  maxDepth: 1,
  maxNodes: 2_000,
  temperatureCp: 35,
  evaluator: { kind: "material", version: 1 },
  opponentHypotheses: {
    kind: "unrestricted-baseline",
    version: 1,
  },
};

const firstAssignment: PlayerPrivateGameAssignment = {
  seed: 70_001,
  parameterSeeds: { white: 80_001, black: 80_002 },
  whiteRuleId: "vegan",
  blackRuleId: "checkers",
};

const secondAssignment: PlayerPrivateGameAssignment = {
  seed: 70_002,
  parameterSeeds: { white: 80_003, black: 80_004 },
  whiteRuleId: "truant",
  blackRuleId: "spice-of-life",
};

let baselineBySeed: ReadonlyMap<number, PlayerPrivateSimulationResult>;

beforeAll(async () => {
  const results = await simulatePlayerPrivateAssignmentsParallel({
    assignments: [firstAssignment, secondAssignment],
    workers: 1,
    policy,
    maxPlies: 1,
  });
  baselineBySeed = new Map(
    results.map((result) => [result.seed, result]),
  );
});

describe("persistent player-private worker pool", () => {
  it("launches one fixed worker per slot across repeated batches", async () => {
    const harness = createHarness();
    const pool = await createPlayerPrivateWorkerPool({
      workers: 2,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });
    try {
      await expect(pool.runBatch([
        indexed(0, firstAssignment),
        indexed(1, secondAssignment),
      ])).resolves.toHaveLength(2);
      await expect(pool.runBatch([
        indexed(2, firstAssignment),
        indexed(3, secondAssignment),
      ])).resolves.toHaveLength(2);

      expect(harness.launches).toBe(2);
      expect(harness.peakActive).toBe(2);
      expect(harness.tasks).toHaveLength(4);
      expect(pool.diagnostics()).toMatchObject({
        configuredWorkers: 2,
        launches: 2,
        activeWorkers: 2,
        peakActiveWorkers: 2,
        completedTasks: 4,
        retriedTasks: 0,
      });
    } finally {
      await pool.close();
    }
    expect(harness.active).toBe(0);
    expect(pool.diagnostics().activeWorkers).toBe(0);
  });

  it("retries an unchanged task after a typed process failure", async () => {
    const harness = createHarness({
      taskOutcome: ({ initialization, task }) =>
        initialization.generation === 0 && task.attempt === 1
          ? "transient-error"
          : "success",
    });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });
    try {
      const response = await pool.runBatch([
        indexed(5, firstAssignment),
      ]);
      expect(response[0]?.result).toEqual(
        baselineBySeed.get(firstAssignment.seed),
      );
      expect(JSON.stringify(response[0]?.result)).toBe(
        JSON.stringify(baselineBySeed.get(firstAssignment.seed)),
      );
      expect(harness.tasks).toHaveLength(2);
      expect(harness.tasks.map((task) => task.attempt)).toEqual([1, 2]);
      expect(harness.tasks[1]?.assignedGames).toEqual(
        harness.tasks[0]?.assignedGames,
      );
      expect(
        JSON.stringify(harness.tasks[1]?.assignedGames),
      ).toBe(JSON.stringify(harness.tasks[0]?.assignedGames));
      expect(pool.diagnostics()).toMatchObject({
        launches: 2,
        peakActiveWorkers: 1,
        completedTasks: 1,
        retriedTasks: 1,
      });
    } finally {
      await pool.close();
    }
    expect(harness.active).toBe(0);
  });

  it("replaces a worker after a task-reported transient runtime failure", async () => {
    const harness = createHarness({
      taskOutcome: ({ initialization, task }) =>
        initialization.generation === 0 && task.attempt === 1
          ? "transient-failure"
          : "success",
    });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });
    try {
      const response = await pool.runBatch([
        indexed(6, firstAssignment),
      ]);
      expect(JSON.stringify(response[0]?.result)).toBe(
        JSON.stringify(baselineBySeed.get(firstAssignment.seed)),
      );
      expect(harness.tasks.map((task) => task.attempt)).toEqual([1, 2]);
      expect(pool.diagnostics()).toMatchObject({
        launches: 2,
        peakActiveWorkers: 1,
        completedTasks: 1,
        retriedTasks: 1,
      });
    } finally {
      await pool.close();
    }
    expect(harness.active).toBe(0);
  });

  it("rejects forged task identity without retrying", async () => {
    const harness = createHarness({
      taskOutcome: () => "forged-result",
    });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });
    try {
      await expect(pool.runBatch([
        indexed(0, firstAssignment),
      ])).rejects.toThrow("invalid task response");
      expect(harness.launches).toBe(1);
      expect(harness.tasks).toHaveLength(1);
      expect(pool.diagnostics().retriedTasks).toBe(0);
    } finally {
      await pool.close();
    }
    expect(harness.active).toBe(0);
  });

  it("rejects a permanent task failure without retrying", async () => {
    const harness = createHarness({
      taskOutcome: () => "permanent-failure",
    });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });
    try {
      await expect(pool.runBatch([
        indexed(0, firstAssignment),
      ])).rejects.toThrow("deterministic task rejection");
      expect(harness.launches).toBe(1);
      expect(harness.tasks).toHaveLength(1);
      expect(pool.diagnostics().retriedTasks).toBe(0);
    } finally {
      await pool.close();
    }
    expect(harness.active).toBe(0);
  });

  it("cleans every launched worker after forged initialization", async () => {
    const harness = createHarness({ forgeReady: true });
    await expect(createPlayerPrivateWorkerPool({
      workers: 2,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    })).rejects.toThrow("invalid ready response");
    expect(harness.launches).toBe(2);
    expect(harness.active).toBe(0);
    expect(harness.peakActive).toBeLessThanOrEqual(2);
  });

  it("treats synchronous spawn failure as permanent and cleans ready peers", async () => {
    const harness = createHarness({ spawnFailureWorkerId: 1 });
    await expect(createPlayerPrivateWorkerPool({
      workers: 2,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    })).rejects.toThrow("simulated synchronous spawn failure");

    expect(harness.launches).toBe(2);
    expect(harness.active).toBe(0);
    expect(harness.peakActive).toBe(1);
  });

  it("cancels active work and leaves zero workers on parent shutdown", async () => {
    const harness = createHarness({
      taskOutcome: () => "hold",
    });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 2,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });
    const pending = pool.runBatch([
      indexed(0, firstAssignment),
      indexed(1, secondAssignment),
    ]);
    await until(() => harness.tasks.length === 2);
    await pool.close();

    await expect(pending).rejects.toThrow("cancelled");
    expect(harness.active).toBe(0);
    expect(pool.diagnostics().activeWorkers).toBe(0);
    expect(harness.peakActive).toBeLessThanOrEqual(2);
  });
});

type TaskOutcome =
  | "success"
  | "transient-error"
  | "transient-failure"
  | "forged-result"
  | "permanent-failure"
  | "hold";

interface HarnessOptions {
  readonly forgeReady?: boolean;
  readonly spawnFailureWorkerId?: number;
  readonly taskOutcome?: (context: {
    readonly initialization: PlayerPrivateWorkerFactoryRequest["workerData"];
    readonly task: PlayerPrivateWorkerTask;
  }) => TaskOutcome;
}

interface WorkerHarness {
  readonly factory: PlayerPrivateWorkerFactory;
  launches: number;
  active: number;
  peakActive: number;
  readonly tasks: PlayerPrivateWorkerTask[];
}

function createHarness(options: HarnessOptions = {}): WorkerHarness {
  const harness: WorkerHarness = {
    factory: (request) => {
      if (request.workerData.workerId === options.spawnFailureWorkerId) {
        harness.launches += 1;
        throw new TypeError("simulated synchronous spawn failure");
      }
      return createFakeTransport(harness, request, options);
    },
    launches: 0,
    active: 0,
    peakActive: 0,
    tasks: [],
  };
  return harness;
}

function createFakeTransport(
  harness: WorkerHarness,
  request: PlayerPrivateWorkerFactoryRequest,
  options: HarnessOptions,
): PlayerPrivateWorkerTransport {
  harness.launches += 1;
  harness.active += 1;
  harness.peakActive = Math.max(harness.peakActive, harness.active);
  let handlers: PlayerPrivateWorkerTransportHandlers | undefined;
  let terminated = false;
  const identity = identityOf(request.workerData);
  return {
    postMessage(value: unknown): void {
      const subscribed = handlers;
      if (subscribed === undefined) {
        throw new Error("Fake worker is not subscribed.");
      }
      const record = protocolRecord(value, "fake worker parent message");
      if (record["kind"] === "player-private-worker-shutdown") {
        assertPlayerPrivateWorkerShutdown(value, identity);
        const stopped = {
          schemaVersion: 2,
          kind: "player-private-worker-stopped",
          ...identity,
        } satisfies PlayerPrivateWorkerStopped;
        queueMicrotask(() => {
          handlers?.message(stopped);
        });
        return;
      }
      assertPlayerPrivateWorkerTask(value, identity);
      harness.tasks.push(structuredClone(value));
      const outcome =
        options.taskOutcome?.({
          initialization: request.workerData,
          task: value,
        }) ?? "success";
      if (outcome === "hold") {
        return;
      }
      if (outcome === "transient-error") {
        queueMicrotask(() => {
          handlers?.error(new Error("simulated worker process exit"));
        });
        return;
      }
      if (outcome === "transient-failure") {
        const failure = {
          schemaVersion: 2,
          kind: "player-private-worker-task-failure",
          ...identity,
          taskId: value.taskId,
          attempt: value.attempt,
          failure: {
            code: "worker-runtime-failed",
            transient: true,
            message: "simulated evaluator process failure",
          },
        } satisfies PlayerPrivateWorkerTaskFailure;
        queueMicrotask(() => {
          handlers?.message(failure);
        });
        return;
      }
      if (outcome === "permanent-failure") {
        const failure = {
          schemaVersion: 2,
          kind: "player-private-worker-task-failure",
          ...identity,
          taskId: value.taskId,
          attempt: value.attempt,
          failure: {
            code: "task-failed",
            transient: false,
            message: "deterministic task rejection",
          },
        } satisfies PlayerPrivateWorkerTaskFailure;
        queueMicrotask(() => {
          handlers?.message(failure);
        });
        return;
      }
      const response = successfulResponse(value, identity);
      queueMicrotask(() => {
        handlers?.message(
          outcome === "forged-result"
            ? {
                ...response,
                authenticationToken: `${identity.authenticationToken}-forged`,
              }
            : response,
        );
      });
    },
    subscribe(nextHandlers): () => void {
      handlers = nextHandlers;
      const ready = {
        schemaVersion: 2,
        kind: "player-private-worker-ready",
        ...identity,
        ...(options.forgeReady
          ? {
              authenticationToken:
                `${identity.authenticationToken}-forged`,
            }
          : {}),
      } satisfies PlayerPrivateWorkerReady;
      queueMicrotask(() => {
        handlers?.message(ready);
      });
      return (): void => {
        handlers = undefined;
      };
    },
    terminate(): Promise<number> {
      if (!terminated) {
        terminated = true;
        harness.active -= 1;
        const subscribed = handlers;
        queueMicrotask(() => {
          subscribed?.exit(0);
        });
      }
      return Promise.resolve(0);
    },
  };
}

function successfulResponse(
  task: PlayerPrivateWorkerTask,
  identity: PlayerPrivateWorkerIdentity,
): PlayerPrivateWorkerTaskResult {
  return {
    schemaVersion: 2,
    kind: "player-private-worker-task-result",
    ...identity,
    taskId: task.taskId,
    attempt: task.attempt,
    games: task.assignedGames.map(({ gameIndex, assignment }) => {
      const result = baselineBySeed.get(assignment.seed);
      if (result === undefined) {
        throw new Error("Missing fake worker baseline result.");
      }
      return { gameIndex, result };
    }),
  };
}

function identityOf(
  initialization: PlayerPrivateWorkerFactoryRequest["workerData"],
): PlayerPrivateWorkerIdentity {
  return {
    poolId: initialization.poolId,
    workerId: initialization.workerId,
    generation: initialization.generation,
    authenticationToken: initialization.authenticationToken,
  };
}

function indexed(
  gameIndex: number,
  assignment: PlayerPrivateGameAssignment,
): IndexedPlayerPrivateAssignment {
  return { gameIndex, assignment };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error("Timed out waiting for fake worker tasks.");
}
