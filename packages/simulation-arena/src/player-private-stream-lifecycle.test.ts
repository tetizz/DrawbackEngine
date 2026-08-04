import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  IncompleteSameOwnerCleanupError,
} from "@drawbackengine/chess-evaluator";
import type {
  PlayerPrivateSimulationResult,
} from "./player-private-simulation.js";

const lifecycle = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  create: vi.fn(),
  runBatch: vi.fn(),
}));

vi.mock("./player-private-worker-pool.js", () => ({
  createPlayerPrivateWorkerPool: () => {
    lifecycle.create();
    return Promise.resolve({
      runBatch: lifecycle.runBatch,
      diagnostics: () => ({
        configuredWorkers: 1,
        launches: 1,
        activeWorkers: 1,
        peakActiveWorkers: 1,
        completedTasks: 0,
        retriedTasks: 0,
      }),
      close: lifecycle.close,
    });
  },
}));

import {
  createPlayerPrivateAssignmentSchedule,
} from "./player-private-assignment-scheduler.js";
import type {
  PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";
import {
  streamPlayerPrivateAssignmentsParallel,
} from "./player-private-stream.js";

const policy: PlayerPrivateSearchPolicy = {
  policyId: "stream-cancellation-test",
  maxDepth: 1,
  maxNodes: 2,
  temperatureCp: 35,
  evaluator: { kind: "material", version: 1 },
  opponentHypotheses: {
    kind: "unrestricted-baseline",
    version: 1,
  },
};

beforeEach(() => {
  lifecycle.close.mockReset();
  lifecycle.close.mockResolvedValue();
  lifecycle.create.mockReset();
  lifecycle.runBatch.mockReset();
  lifecycle.runBatch.mockImplementation(
    (
      assignedGames: readonly {
        readonly gameIndex: number;
      }[],
    ) => Promise.resolve(assignedGames.map(({ gameIndex }) => ({
      gameIndex,
      result: {} as PlayerPrivateSimulationResult,
    }))),
  );
});

describe("player-private stream worker lifecycle", () => {
  it("closes the persistent pool and source on iterator cancellation", async () => {
    let sourceClosed = false;
    const source = createPlayerPrivateAssignmentSchedule({
      splitCounts: { train: 2, validation: 0, test: 0 },
      labelSeed: 11,
      gameplaySeed: 12,
      parameterSeed: 13,
    });
    const observedSource = {
      *[Symbol.iterator]() {
        try {
          yield* source;
        } finally {
          sourceClosed = true;
        }
      },
    };
    const iterator = streamPlayerPrivateAssignmentsParallel({
      assignments: observedSource,
      workers: 1,
      windowSize: 1,
      policy,
      maxPlies: 1,
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    expect(lifecycle.close).not.toHaveBeenCalled();
    await iterator.return?.();

    expect(lifecycle.close).toHaveBeenCalledTimes(1);
    expect(sourceClosed).toBe(true);
  });

  it("closes the persistent pool after a task failure", async () => {
    lifecycle.runBatch.mockRejectedValueOnce(
      new Error("simulated task failure"),
    );
    const consume = async (): Promise<void> => {
      for await (const game of streamPlayerPrivateAssignmentsParallel({
        assignments: createPlayerPrivateAssignmentSchedule({
          splitCounts: { train: 1, validation: 0, test: 0 },
          labelSeed: 21,
          gameplaySeed: 22,
          parameterSeed: 23,
        }),
        workers: 1,
        windowSize: 1,
        policy,
        maxPlies: 1,
      })) {
        void game;
      }
    };

    await expect(consume()).rejects.toThrow("simulated task failure");
    expect(lifecycle.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a pre-aborted stream before creating worker resources", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Synthetic pre-abort."));
    const stream = streamPlayerPrivateAssignmentsParallel({
      assignments: createPlayerPrivateAssignmentSchedule({
        splitCounts: { train: 1, validation: 0, test: 0 },
        labelSeed: 31,
        gameplaySeed: 32,
        parameterSeed: 33,
      }),
      workers: 1,
      windowSize: 1,
      policy,
      maxPlies: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(stream.next()).rejects.toThrow("Synthetic pre-abort");
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.runBatch).not.toHaveBeenCalled();
    expect(lifecycle.close).not.toHaveBeenCalled();
  });

  it("aborts an active batch through one memoized pool cleanup", async () => {
    let rejectBatch: ((reason: unknown) => void) | undefined;
    lifecycle.runBatch.mockReturnValue(new Promise((_resolve, reject) => {
      rejectBatch = reject;
    }));
    lifecycle.close.mockImplementation(() => {
      rejectBatch?.(new Error("Synthetic batch cancellation."));
      return Promise.resolve();
    });
    let sourceClosed = false;
    const source = createPlayerPrivateAssignmentSchedule({
      splitCounts: { train: 1, validation: 0, test: 0 },
      labelSeed: 41,
      gameplaySeed: 42,
      parameterSeed: 43,
    });
    const observedSource = {
      *[Symbol.iterator]() {
        try {
          yield* source;
        } finally {
          sourceClosed = true;
        }
      },
    };
    const controller = new AbortController();
    const iterator = streamPlayerPrivateAssignmentsParallel({
      assignments: observedSource,
      workers: 1,
      windowSize: 1,
      policy,
      maxPlies: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => {
      expect(lifecycle.runBatch).toHaveBeenCalledOnce();
    });

    controller.abort(new Error("Synthetic active abort."));

    const failure = await next.catch((error: unknown) => error);
    expect(allErrorMessages(failure)).toContain("Synthetic active abort.");
    expect(lifecycle.close).toHaveBeenCalledTimes(1);
    expect(sourceClosed).toBe(true);
  });

  it("preserves abort and pool cleanup failures without closing twice", async () => {
    let rejectBatch: ((reason: unknown) => void) | undefined;
    lifecycle.runBatch.mockReturnValue(new Promise((_resolve, reject) => {
      rejectBatch = reject;
    }));
    lifecycle.close.mockImplementation(() => {
      rejectBatch?.(new Error("Synthetic batch cancellation."));
      return Promise.reject(new Error("Synthetic close failure."));
    });
    const controller = new AbortController();
    const iterator = streamPlayerPrivateAssignmentsParallel({
      assignments: createPlayerPrivateAssignmentSchedule({
        splitCounts: { train: 1, validation: 0, test: 0 },
        labelSeed: 51,
        gameplaySeed: 52,
        parameterSeed: 53,
      }),
      workers: 1,
      windowSize: 1,
      policy,
      maxPlies: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => {
      expect(lifecycle.runBatch).toHaveBeenCalledOnce();
    });

    controller.abort(new Error("Synthetic abort with cleanup failure."));
    const failure = await next.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(allErrorMessages(failure)).toEqual(expect.arrayContaining([
      "Synthetic abort with cleanup failure.",
      "Synthetic close failure.",
    ]));
    expect(lifecycle.close).toHaveBeenCalledTimes(1);
  });

  it("preserves a retained owner from the interrupted batch operation", async () => {
    const retryCleanup = vi.fn(() => Promise.resolve());
    const retained = new IncompleteSameOwnerCleanupError(
      [new Error("Synthetic evaluator cleanup remains incomplete.")],
      "Synthetic retained evaluator cleanup.",
      retryCleanup,
    );
    let rejectBatch: ((reason: unknown) => void) | undefined;
    lifecycle.runBatch.mockReturnValue(new Promise((_resolve, reject) => {
      rejectBatch = reject;
    }));
    lifecycle.close.mockImplementation(() => {
      rejectBatch?.(retained);
      return Promise.resolve();
    });
    const controller = new AbortController();
    const iterator = streamPlayerPrivateAssignmentsParallel({
      assignments: createPlayerPrivateAssignmentSchedule({
        splitCounts: { train: 1, validation: 0, test: 0 },
        labelSeed: 61,
        gameplaySeed: 62,
        parameterSeed: 63,
      }),
      workers: 1,
      windowSize: 1,
      policy,
      maxPlies: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => {
      expect(lifecycle.runBatch).toHaveBeenCalledOnce();
    });

    controller.abort(new Error("Synthetic retained-owner abort."));
    const failure = await next.catch((error: unknown) => error);
    const discovered = findError(
      failure,
      IncompleteSameOwnerCleanupError,
    );

    expect(discovered).toBe(retained);
    await discovered?.retryCleanup();
    expect(retryCleanup).toHaveBeenCalledTimes(1);
    expect(lifecycle.close).toHaveBeenCalledTimes(1);
  });
});

function findError<T extends Error>(
  value: unknown,
  constructor: abstract new (...args: never[]) => T,
): T | undefined {
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof constructor) {
      return current;
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors as readonly unknown[]);
    }
    if (current instanceof Error && current.cause !== undefined) {
      pending.push(current.cause);
    }
  }
  return undefined;
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
