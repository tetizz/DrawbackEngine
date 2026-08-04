import { describe, expect, it } from "vitest";
import {
  createPlayerPrivateSimulationTrace,
} from "./player-private-trace.js";
import {
  createPlayerPrivateAssignmentSchedule,
  type ScheduledPlayerPrivateAssignment,
} from "./player-private-assignment-scheduler.js";
import {
  streamPlayerPrivateAssignmentsParallel,
} from "./player-private-stream.js";
import {
  simulatePlayerPrivateAssignmentsParallel,
} from "./player-private-parallel.js";
import {
  PlayerPrivateWorkerPoolCleanupError,
} from "./player-private-worker-pool.js";
import type {
  PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";

const policy: PlayerPrivateSearchPolicy = {
  policyId: "stream-material-search-v1",
  maxDepth: 1,
  maxNodes: 2_000,
  temperatureCp: 35,
  leafCacheEntries: 1_024,
  leafCacheHistoryMode: "full",
  evaluator: { kind: "material", version: 1 },
  opponentHypotheses: {
    kind: "unrestricted-baseline",
    version: 1,
  },
};

function schedule(count: number): Iterable<ScheduledPlayerPrivateAssignment> {
  return createPlayerPrivateAssignmentSchedule({
    splitCounts: { train: count, validation: 0, test: 0 },
    labelSeed: 1,
    gameplaySeed: 2,
    parameterSeed: 3,
  });
}

describe("streaming player-private parallel simulation", () => {
  it(
    "is byte-identical across worker and window sizes",
    async () => {
      const scheduled = [...schedule(6)];
      const oneShot = await simulatePlayerPrivateAssignmentsParallel({
        assignments: scheduled.map(({ assignment }) => assignment),
        workers: 2,
        policy,
        maxPlies: 2,
      });
      const oneShotTraces = oneShot.map((result, index) =>
        createPlayerPrivateSimulationTrace(
          result,
          scheduled[index]?.globalIndex ?? index,
        )
      );
      const serial = await collectTraces(
        streamPlayerPrivateAssignmentsParallel({
          assignments: scheduled,
          workers: 1,
          windowSize: 1,
          policy,
          maxPlies: 2,
        }),
      );
      const parallel = await collectTraces(
        streamPlayerPrivateAssignmentsParallel({
          assignments: schedule(6),
          workers: 2,
          windowSize: 4,
          policy,
          maxPlies: 2,
        }),
      );
      expect(serial).toEqual(oneShotTraces);
      expect(JSON.stringify(serial)).toBe(JSON.stringify(oneShotTraces));
      expect(parallel).toEqual(serial);
      expect(JSON.stringify(parallel)).toBe(JSON.stringify(serial));
    },
    30_000,
  );

  it(
    "does not read beyond the current bounded window",
    async () => {
      let reads = 0;
      const source = schedule(5);
      const counted: Iterable<ScheduledPlayerPrivateAssignment> = {
        *[Symbol.iterator]() {
          for (const assignment of source) {
            reads += 1;
            yield assignment;
          }
        },
      };
      const mutablePolicy = {
        ...policy,
        evaluator: { ...policy.evaluator },
        opponentHypotheses: { ...policy.opponentHypotheses },
      };
      const iterator = streamPlayerPrivateAssignmentsParallel({
        assignments: counted,
        workers: 1,
        windowSize: 2,
        policy: mutablePolicy,
        maxPlies: 1,
      })[Symbol.asyncIterator]();
      mutablePolicy.maxNodes = 2;

      expect(reads).toBe(0);
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({
        result: {
          agents: {
            white: {
              searchPolicy: { maxNodes: 2_000 },
            },
          },
        },
      });
      expect(reads).toBe(2);
      expect((await iterator.next()).done).toBe(false);
      expect(reads).toBe(2);
      expect((await iterator.next()).done).toBe(false);
      expect(reads).toBe(4);
      await iterator.return?.();
    },
    30_000,
  );

  it(
    "closes a real worker pool when aborted while suspended after a result",
    async () => {
      const controller = new AbortController();
      const iterator = streamPlayerPrivateAssignmentsParallel({
        assignments: schedule(2),
        workers: 1,
        windowSize: 1,
        policy,
        maxPlies: 1,
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      expect((await iterator.next()).done).toBe(false);
      controller.abort(new Error("Synthetic post-result interruption."));
      await expect(iterator.return?.()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    },
    30_000,
  );

  it("rejects a non-contiguous or reordered schedule before simulation", async () => {
    const assignments = [...schedule(2)];
    const second = assignments[1];
    if (second === undefined) {
      throw new Error("Expected two assignments.");
    }
    const invalid = [
      assignments[0],
      { ...second, globalIndex: 9 },
    ].filter(
      (value): value is ScheduledPlayerPrivateAssignment =>
        value !== undefined,
    );
    const consume = async (): Promise<void> => {
      for await (const result of streamPlayerPrivateAssignmentsParallel({
        assignments: invalid,
        workers: 1,
        windowSize: 2,
        policy,
        maxPlies: 1,
      })) {
        // The invalid second item must fail before the window is dispatched.
        void result;
      }
    };
    await expect(consume()).rejects.toThrow("contiguous increasing");
  });

  it("preserves a retained cleanup owner when iterator return also fails", async () => {
    const retained = new PlayerPrivateWorkerPoolCleanupError(
      [new Error("Worker cleanup remains incomplete.")],
      "Worker cleanup remains incomplete.",
      () => Promise.resolve(),
      () => ({
        configuredWorkers: 1,
        launches: 1,
        activeWorkers: 1,
        peakActiveWorkers: 1,
        completedTasks: 0,
        retriedTasks: 0,
      }),
    );
    const iteratorFailure = new Error("Iterator return failed.");
    const assignments: Iterable<ScheduledPlayerPrivateAssignment> = {
      [Symbol.iterator](): Iterator<ScheduledPlayerPrivateAssignment> {
        return {
          next(): IteratorResult<ScheduledPlayerPrivateAssignment> {
            throw retained;
          },
          return(): IteratorResult<ScheduledPlayerPrivateAssignment> {
            throw iteratorFailure;
          },
        };
      },
    };
    const stream = streamPlayerPrivateAssignmentsParallel({
      assignments,
      workers: 1,
      windowSize: 1,
      policy,
      maxPlies: 1,
    })[Symbol.asyncIterator]();

    const failure = await stream.next().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      retained,
      iteratorFailure,
    ]);
  });
});

async function collectTraces(
  stream: AsyncIterable<{
    readonly globalIndex: number;
    readonly result: Parameters<
      typeof createPlayerPrivateSimulationTrace
    >[0];
  }>,
): Promise<readonly unknown[]> {
  const records: unknown[] = [];
  for await (const game of stream) {
    records.push(
      createPlayerPrivateSimulationTrace(game.result, game.globalIndex),
    );
  }
  return records;
}
