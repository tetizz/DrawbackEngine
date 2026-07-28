import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  PlayerPrivateSimulationResult,
} from "./player-private-simulation.js";

const lifecycle = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  runBatch: vi.fn(),
}));

vi.mock("./player-private-worker-pool.js", () => ({
  createPlayerPrivateWorkerPool: () => Promise.resolve({
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
  }),
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
});
