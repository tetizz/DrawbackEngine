import {
  beforeAll,
  describe,
  expect,
  it,
  vi,
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
  type PlayerPrivateWorkerInitializationFailure,
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
  PlayerPrivateWorkerPoolCleanupError,
  PlayerPrivateWorkerPoolCreationError,
} from "./player-private-worker-pool.js";
import {
  PlayerPrivateWorkerSlot,
  type PlayerPrivateWorkerHostedEvaluator,
} from "./player-private-worker-slot.js";
import {
  createNodePlayerPrivateWorker,
  type PlayerPrivateWorkerFactory,
  type PlayerPrivateWorkerFactoryRequest,
  type PlayerPrivateWorkerTransport,
  type PlayerPrivateWorkerTransportHandlers,
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
  it("does not attach one parent stdio error listener per worker", async () => {
    const stdoutListeners = process.stdout.listenerCount("error");
    const stderrListeners = process.stderr.listenerCount("error");
    const pool = await createPlayerPrivateWorkerPool({
      workers: 15,
      policy,
      maxPlies: 1,
      workerFactory: createNodePlayerPrivateWorker,
    });
    try {
      expect(process.stdout.listenerCount("error")).toBe(stdoutListeners);
      expect(process.stderr.listenerCount("error")).toBe(stderrListeners);
    } finally {
      await pool.close();
    }
    expect(process.stdout.listenerCount("error")).toBe(stdoutListeners);
    expect(process.stderr.listenerCount("error")).toBe(stderrListeners);
  }, 30_000);

  it.each(["stdout", "stderr"] as const)(
    "fails closed on unexpected worker %s output",
    async (stream) => {
      const source = [
        `process.${stream}.write("unexpected worker output");`,
        "setInterval(() => undefined, 1_000);",
      ].join("\n");
      const failure = await createPlayerPrivateWorkerPool({
        workers: 1,
        policy,
        maxPlies: 1,
        attempts: 1,
        initializationTimeoutMs: 5_000,
        workerFactory: (request) => createNodePlayerPrivateWorker({
          ...request,
          entry: new URL(
            `data:text/javascript,${encodeURIComponent(source)}`,
          ),
        }),
      }).then(
        async (pool) => {
          await pool.close();
          return undefined;
        },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(errorMessages(failure).join(" ")).toContain(
        `Player-private worker wrote unexpected ${stream} output.`,
      );
    },
  );

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
    const failure = await createPlayerPrivateWorkerPool({
      workers: 2,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    }).catch((error: unknown) => error);
    expect(errorMessages(failure)).toEqual(expect.arrayContaining([
      expect.stringContaining("invalid ready response"),
    ]));
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

    const failure = await pending.catch((error: unknown) => error);
    expect(errorMessages(failure)).toEqual(expect.arrayContaining([
      expect.stringContaining("cancelled"),
    ]));
    expect(harness.active).toBe(0);
    expect(pool.diagnostics().activeWorkers).toBe(0);
    expect(harness.peakActive).toBeLessThanOrEqual(2);
  });

  it("rejects a wrong evaluator identity without retrying", async () => {
    const harness = createHarness({ forgeEvaluatorId: true });
    await expect(createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    })).rejects.toThrow("invalid ready response");
    expect(harness.launches).toBe(1);
    expect(harness.active).toBe(0);
  });

  it("settles and preserves every concurrent shard failure", async () => {
    const harness = createHarness({
      taskOutcome: () => "permanent-failure",
    });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 2,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });
    try {
      const failure = await pool.runBatch([
        indexed(0, firstAssignment),
        indexed(1, secondAssignment),
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toHaveLength(2);
      expect(harness.tasks).toHaveLength(2);
    } finally {
      await pool.close();
    }
    expect(harness.active).toBe(0);
  });

  it("does not retry a permanent evaluator initialization failure", async () => {
    const harness = createHarness({
      initializationOutcome: () => "permanent-failure",
    });
    await expect(createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    })).rejects.toThrow("evaluator initialization failed");
    expect(harness.launches).toBe(1);
    expect(harness.active).toBe(0);
  });

  it("preserves initialization failures and retains an owned cleanup handle", async () => {
    const harness = createHarness({
      initializationOutcome: () => "permanent-failure",
      terminateFailures: Number.POSITIVE_INFINITY,
    });
    const failure = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      attempts: 1,
      workerFactory: harness.factory,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlayerPrivateWorkerPoolCreationError);
    expect(errorMessages(failure)).toEqual(expect.arrayContaining([
      expect.stringContaining("evaluator initialization failed"),
      expect.stringContaining("simulated worker termination failure"),
    ]));
    expect(harness.active).toBe(1);
    if (!(failure instanceof PlayerPrivateWorkerPoolCreationError)) {
      throw new Error("Expected a retryable pool creation error.");
    }
    expect(failure.diagnostics().activeWorkers).toBe(1);
    await expect(failure.retryCleanup()).rejects.toThrow(
      "worker pool cleanup failed",
    );
    expect(failure.diagnostics().activeWorkers).toBe(1);
  });

  it("retries retained pool cleanup without launching a replacement", async () => {
    const harness = createHarness({
      initializationOutcome: () => "permanent-failure",
      terminateFailures: 3,
    });
    const failure = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      attempts: 1,
      workerFactory: harness.factory,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlayerPrivateWorkerPoolCreationError);
    expect(harness.active).toBe(1);
    expect(harness.launches).toBe(1);
    if (!(failure instanceof PlayerPrivateWorkerPoolCreationError)) {
      throw new Error("Expected a retryable pool creation error.");
    }

    await expect(failure.retryCleanup()).resolves.toBeUndefined();
    expect(harness.active).toBe(0);
    expect(harness.launches).toBe(1);
    expect(failure.diagnostics().activeWorkers).toBe(0);
  });

  it("replaces a worker after a transient evaluator initialization failure", async () => {
    const harness = createHarness({
      initializationOutcome: (initialization) =>
        initialization.generation === 0
          ? "transient-failure"
          : "success",
    });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });
    expect(harness.launches).toBe(2);
    await pool.close();
    expect(harness.active).toBe(0);
  });

  it("retries a failed termination before reporting successful cleanup", async () => {
    const harness = createHarness({ terminateFailures: 1 });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });

    await expect(pool.close()).resolves.toBeUndefined();
    expect(harness.terminateAttempts).toBe(2);
    expect(harness.active).toBe(0);
    expect(pool.diagnostics().activeWorkers).toBe(0);
  });

  it("surfaces failed termination and keeps the worker tracked", async () => {
    const harness = createHarness({ terminateFailures: Number.POSITIVE_INFINITY });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });

    const failure = await pool.close().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlayerPrivateWorkerPoolCleanupError);
    expect(errorMessages(failure)).toEqual(expect.arrayContaining([
      "simulated worker termination failure 1",
      "simulated worker termination failure 2",
    ]));
    expect(harness.terminateAttempts).toBe(2);
    expect(harness.active).toBe(1);
    expect(pool.diagnostics().activeWorkers).toBe(1);
  });

  it("rejects a nonzero worker exit without an authenticated stop response", async () => {
    const harness = createHarness({ shutdownExitCode: 17 });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });

    await expect(pool.close()).rejects.toThrow(
      "worker pool cleanup completed abnormally",
    );
    expect(harness.active).toBe(0);
    expect(pool.diagnostics().activeWorkers).toBe(0);
  });

  it("rejects a forged worker stop response", async () => {
    const harness = createHarness({ forgeStopped: true });
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      workerFactory: harness.factory,
    });

    await expect(pool.close()).rejects.toThrow(
      "worker pool cleanup completed abnormally",
    );
    expect(harness.active).toBe(0);
    expect(pool.diagnostics().activeWorkers).toBe(0);
  });
});

describe("parent-owned evaluator cleanup retries", () => {
  it("clears the shutdown deadline after an early stop rejection", async () => {
    vi.useFakeTimers();
    const identity = {
      poolId: "pool-shutdown-timer",
      workerId: 0,
      generation: 0,
      authenticationToken: "auth-shutdown-timer",
    } as const satisfies PlayerPrivateWorkerIdentity;
    let handlers: PlayerPrivateWorkerTransportHandlers | undefined;
    const transport: PlayerPrivateWorkerTransport = {
      postMessage(value: unknown): void {
        assertPlayerPrivateWorkerShutdown(value, identity);
        queueMicrotask(() => {
          handlers?.exit(17);
        });
      },
      subscribe(nextHandlers): () => void {
        handlers = nextHandlers;
        queueMicrotask(() => {
          nextHandlers.message({
            schemaVersion: 2,
            kind: "player-private-worker-ready",
            ...identity,
            evaluatorId: "drawback-material/v1",
          } satisfies PlayerPrivateWorkerReady);
        });
        return (): void => {
          handlers = undefined;
        };
      },
      terminate(): Promise<number> {
        return Promise.resolve(17);
      },
    };
    const slot = new PlayerPrivateWorkerSlot(
      identity,
      transport,
      1_000,
      "drawback-material/v1",
      () => undefined,
    );
    try {
      await slot.initialize();
      await expect(slot.closeGracefully(5_000)).rejects.toThrow(
        "exited before authenticating a clean shutdown",
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await slot.terminateNow().catch(() => undefined);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("handles a fire-and-forget failure and retries hosted cleanup to success", async () => {
    const identity = {
      poolId: "pool-hosted-close-retry",
      workerId: 0,
      generation: 0,
      authenticationToken: "auth-hosted-close-retry",
    } as const satisfies PlayerPrivateWorkerIdentity;
    const evaluatorId = "hosted-close-retry-evaluator";
    let handlers: PlayerPrivateWorkerTransportHandlers | undefined;
    let evaluatorCloseAttempts = 0;
    let workerTerminateAttempts = 0;
    let closedNotifications = 0;
    const hostedEvaluator: PlayerPrivateWorkerHostedEvaluator = {
      id: evaluatorId,
      evaluate: () => Promise.resolve(0),
      close: () => {
        evaluatorCloseAttempts += 1;
        return evaluatorCloseAttempts === 1
          ? Promise.reject(new Error("simulated hosted evaluator close failure"))
          : Promise.resolve();
      },
    };
    const transport: PlayerPrivateWorkerTransport = {
      postMessage(): void {
        // This regression exercises process-error cleanup, not task dispatch.
      },
      subscribe(nextHandlers): () => void {
        handlers = nextHandlers;
        queueMicrotask(() => {
          nextHandlers.message({
            schemaVersion: 2,
            kind: "player-private-worker-ready",
            ...identity,
            evaluatorId,
          } satisfies PlayerPrivateWorkerReady);
        });
        return (): void => {
          handlers = undefined;
        };
      },
      terminate(): Promise<number> {
        workerTerminateAttempts += 1;
        return Promise.resolve(0);
      },
    };
    const slot = new PlayerPrivateWorkerSlot(
      identity,
      transport,
      1_000,
      evaluatorId,
      () => {
        closedNotifications += 1;
      },
      hostedEvaluator,
    );
    await slot.initialize();
    if (handlers === undefined) {
      throw new Error("Expected the worker slot to remain subscribed.");
    }
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    try {
      handlers.error(new Error("simulated worker process failure"));
      await until(() => evaluatorCloseAttempts === 1);
      await eventLoopTurn();

      const retryFailure = await slot.terminateNow().then(
        () => undefined,
        (error: unknown) => error,
      );
      await eventLoopTurn();

      expect(retryFailure).toBeUndefined();
      expect(evaluatorCloseAttempts).toBe(2);
      expect(workerTerminateAttempts).toBe(2);
      expect(closedNotifications).toBe(1);
      expect(unhandled).toEqual([]);

      await expect(slot.terminateNow()).resolves.toBeUndefined();
      expect(evaluatorCloseAttempts).toBe(2);
      expect(workerTerminateAttempts).toBe(2);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
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
  readonly forgeEvaluatorId?: boolean;
  readonly forgeStopped?: boolean;
  readonly spawnFailureWorkerId?: number;
  readonly terminateFailures?: number;
  readonly shutdownExitCode?: number;
  readonly initializationOutcome?: (
    initialization: PlayerPrivateWorkerFactoryRequest["workerData"],
  ) => "success" | "transient-failure" | "permanent-failure";
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
  terminateAttempts: number;
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
    terminateAttempts: 0,
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
        if (options.shutdownExitCode !== undefined) {
          if (!terminated) {
            terminated = true;
            harness.active -= 1;
          }
          queueMicrotask(() => {
            handlers?.exit(options.shutdownExitCode ?? 0);
          });
          return;
        }
        const stopped = {
          schemaVersion: 2,
          kind: "player-private-worker-stopped",
          ...identity,
          ...(options.forgeStopped === true
            ? {
                authenticationToken:
                  `${identity.authenticationToken}-forged`,
              }
            : {}),
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
      const initializationOutcome =
        options.initializationOutcome?.(request.workerData) ?? "success";
      if (initializationOutcome !== "success") {
        const transient = initializationOutcome === "transient-failure";
        const failure = {
          schemaVersion: 2,
          kind: "player-private-worker-initialization-failure",
          ...identity,
          failure: {
            code: transient
              ? "evaluator-unavailable"
              : "initialization-failed",
            transient,
            message: transient
              ? "simulated evaluator process unavailable"
              : "simulated evaluator authentication rejected",
          },
        } satisfies PlayerPrivateWorkerInitializationFailure;
        queueMicrotask(() => {
          handlers?.message(failure);
        });
        return (): void => {
          handlers = undefined;
        };
      }
      const expectedEvaluatorId =
        request.workerData.policy.evaluator.kind === "material"
          ? "drawback-material/v1"
          : request.workerData.policy.evaluator.evaluatorId;
      const ready = {
        schemaVersion: 2,
        kind: "player-private-worker-ready",
        ...identity,
        evaluatorId: options.forgeEvaluatorId === true
          ? `${expectedEvaluatorId}-forged`
          : expectedEvaluatorId,
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
      harness.terminateAttempts += 1;
      if (
        harness.terminateAttempts
        <= (options.terminateFailures ?? 0)
      ) {
        return Promise.reject(
          new Error(
            `simulated worker termination failure ${String(harness.terminateAttempts)}`,
          ),
        );
      }
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

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function errorMessages(value: unknown): readonly string[] {
  if (value instanceof AggregateError) {
    return [
      value.message,
      ...value.errors.flatMap((error: unknown) => errorMessages(error)),
    ];
  }
  return value instanceof Error ? [value.message] : [String(value)];
}
