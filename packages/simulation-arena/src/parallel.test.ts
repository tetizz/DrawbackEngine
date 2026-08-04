import { describe, expect, it } from "vitest";
import {
  assertParallelWorkerRequest,
  assertParallelWorkerResponse,
  simulateBatchParallel,
  simulateCatalogBatchParallel,
} from "./parallel.js";

const CI_TIMEOUT_MS = 30_000;

const spec = {
  whiteRuleId: "vegan",
  blackRuleId: "checkers",
  whiteAgentId: "human-like-medium",
  blackAgentId: "greedy-material",
  maxPlies: 8,
} as const;

function serialized(
  games: Awaited<ReturnType<typeof simulateBatchParallel>>,
): string {
  return JSON.stringify(games);
}

describe("parallel simulation", () => {
  it("preserves exact game and row order across worker counts", async () => {
    const serialWorkers = await simulateBatchParallel({
      seed: 31415,
      games: 5,
      workers: 1,
      spec,
    });
    const parallelWorkers = await simulateBatchParallel({
      seed: 31415,
      games: 5,
      workers: 3,
      spec,
    });
    expect(parallelWorkers).toEqual(serialWorkers);
    expect(serialized(parallelWorkers)).toBe(serialized(serialWorkers));
  });

  it(
    "is reproducible for repeated parallel runs",
    async () => {
      const request = { seed: 7, games: 2, workers: 2, spec } as const;
      expect(await simulateBatchParallel(request)).toEqual(
        await simulateBatchParallel(request),
      );
    },
    CI_TIMEOUT_MS,
  );

  it("rejects invalid worker and game counts", async () => {
    await expect(
      simulateBatchParallel({ seed: 1, games: 1, workers: 0, spec }),
    ).rejects.toThrow(RangeError);
    await expect(
      simulateBatchParallel({ seed: 1, games: 0, workers: 1, spec }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects prepared evaluator configuration at the worker boundary", () => {
    const privatePreparedRequest = {
      schemaVersion: 3,
      kind: "prepared-catalog-assignments",
      assignedGames: [{
        gameIndex: 0,
        assignment: {
          seed: 1,
          whiteRuleId: "vegan",
          blackRuleId: "checkers",
          whiteAgentId: "random-legal",
          blackAgentId: "greedy-material",
        },
      }],
      evaluator: {},
      maxPlies: 2,
    };
    expect(() => {
      assertParallelWorkerRequest(privatePreparedRequest);
    }).toThrow("parent-owned");

    const ordinaryRequest = {
      batchSeed: 1,
      gameIndexes: [0],
      spec,
    };
    expect(() => {
      assertParallelWorkerRequest(ordinaryRequest);
    }).not.toThrow();
    expect(() => {
      assertParallelWorkerRequest({
        ...ordinaryRequest,
        evaluator: { process: { executablePath: "private" } },
      });
    }).toThrow("invalid fields");
  });

  it("rejects malformed worker responses as permanent protocol errors", () => {
    expect(() => {
      assertParallelWorkerResponse({ games: [] });
    }).not.toThrow();
    expect(() => {
      assertParallelWorkerResponse({ games: [], extra: true });
    }).toThrow("invalid fields");
    expect(() => {
      assertParallelWorkerResponse({ games: "forged" });
    }).toThrow("must be an array");
  });

  it(
    "keeps randomized catalog batches identical across worker counts",
    async () => {
      const request = {
        seed: 0xabcdef,
        games: 4,
        maxPlies: 6,
      } as const;
      const oneWorker = await simulateCatalogBatchParallel({
        ...request,
        workers: 1,
      });
      const threeWorkers = await simulateCatalogBatchParallel({
        ...request,
        workers: 3,
      });
      expect(threeWorkers).toEqual(oneWorker);
      expect(serialized(threeWorkers)).toBe(serialized(oneWorker));
    },
    CI_TIMEOUT_MS,
  );
});
