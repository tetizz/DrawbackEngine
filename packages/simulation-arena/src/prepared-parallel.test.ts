import { describe, expect, it } from "vitest";
import {
  simulatePreparedCatalogAssignmentsParallel,
  simulatePreparedCatalogSeedsParallel,
} from "./parallel.js";
import { TEST_UCI_CONFIG } from "./test-uci-config.js";

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
});
