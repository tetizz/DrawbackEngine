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
      const serial = await collectTraces(
        streamPlayerPrivateAssignmentsParallel({
          assignments: schedule(6),
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
