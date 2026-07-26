import { describe, expect, it } from "vitest";
import {
  simulatePlayerPrivateAssignmentsParallel,
} from "./player-private-parallel.js";
import {
  assertPlayerPrivateWorkerRequest,
  type PlayerPrivateGameAssignment,
  type PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";
import {
  assertPlayerPrivateWorkerResponse,
} from "./player-private-result-validation.js";

const policy: PlayerPrivateSearchPolicy = {
  policyId: "material-search-v1",
  maxDepth: 1,
  maxNodes: 2_000,
  temperatureCp: 35,
  leafCacheEntries: 1_024,
  leafCacheHistoryMode: "full",
  evaluator: {
    kind: "material",
    version: 1,
  },
  opponentHypotheses: {
    kind: "unrestricted-baseline",
    version: 1,
  },
};

const assignments = [
  {
    seed: 101,
    parameterSeeds: { white: 1_101, black: 1_102 },
    whiteRuleId: "vegan",
    blackRuleId: "checkers",
  },
  {
    seed: 202,
    parameterSeeds: { white: 1_202, black: 1_203 },
    whiteRuleId: "truant",
    blackRuleId: "spice-of-life",
  },
] as const;

describe("parallel player-private simulation", () => {
  it(
    "is byte-identical across worker counts",
    async () => {
      const one = await simulatePlayerPrivateAssignmentsParallel({
        assignments,
        workers: 1,
        policy,
        maxPlies: 4,
      });
      const two = await simulatePlayerPrivateAssignmentsParallel({
        assignments,
        workers: 2,
        policy,
        maxPlies: 4,
      });

      expect(two).toEqual(one);
      expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    },
    30_000,
  );

  it("rejects protocol extras and unsupported rules", () => {
    const valid = {
      schemaVersion: 1,
      kind: "player-private-assignments",
      assignedGames: [{
        gameIndex: 0,
        assignment: assignments[0],
      }],
      policy,
      maxPlies: 2,
    } as const;
    expect(() => {
      assertPlayerPrivateWorkerRequest(valid);
    }).not.toThrow();
    expect(() => {
      assertPlayerPrivateWorkerRequest({ ...valid, secret: true });
    }).toThrow("invalid fields");
    expect(() => {
      assertPlayerPrivateWorkerRequest({
        ...valid,
        policy: { ...policy, maxNodes: 1 },
      });
    }).toThrow("greater than one");
    expect(() => {
      assertPlayerPrivateWorkerRequest({
        ...valid,
        assignedGames: [{
          gameIndex: 0,
          assignment: {
            ...assignments[0],
            blackRuleId: "not-a-rule",
          },
        }],
      });
    }).toThrow("outside the player-private catalog");
  });

  it("snapshots caller-owned assignments and policy before worker retries", async () => {
    const mutableAssignments: PlayerPrivateGameAssignment[] = [{
      seed: 303,
      parameterSeeds: { white: 1_303, black: 1_304 },
      whiteRuleId: "vegan",
      blackRuleId: "checkers",
    }];
    const mutablePolicy = {
      ...policy,
      evaluator: { ...policy.evaluator },
      opponentHypotheses: { ...policy.opponentHypotheses },
    };
    const pending = simulatePlayerPrivateAssignmentsParallel({
      assignments: mutableAssignments,
      workers: 1,
      policy: mutablePolicy,
      maxPlies: 1,
    });

    mutableAssignments[0] = {
      seed: 404,
      parameterSeeds: { white: 1_404, black: 1_405 },
      whiteRuleId: "lame-duck",
      blackRuleId: "truant",
    };
    mutablePolicy.maxNodes = 2;

    const result = await pending;
    expect(result[0]?.seed).toBe(303);
    expect(result[0]?.drawbacks).toEqual({
      white: "vegan",
      black: "checkers",
    });
    expect(result[0]?.agents.white.searchPolicy?.maxNodes).toBe(2_000);
  });

  it("rejects worker results with mismatched search provenance", async () => {
    const assignment = assignments[0];
    const results = await simulatePlayerPrivateAssignmentsParallel({
      assignments: [assignment],
      workers: 1,
      policy,
      maxPlies: 1,
    });
    const result = results[0];
    if (result === undefined) {
      throw new Error("Expected one player-private result.");
    }
    const response = {
      schemaVersion: 1,
      kind: "player-private-results",
      games: [{ gameIndex: 0, result }],
    } as const;
    const assignedGames = [{ gameIndex: 0, assignment }] as const;
    expect(() => {
      assertPlayerPrivateWorkerResponse(
        response,
        assignedGames,
        policy,
        1,
      );
    }).not.toThrow();

    const whitePolicy = result.agents.white.searchPolicy;
    if (whitePolicy === null) {
      throw new Error("Expected search provenance.");
    }
    const corrupted = {
      ...response,
      games: [{
        gameIndex: 0,
        result: {
          ...result,
          agents: {
            ...result.agents,
            white: {
              ...result.agents.white,
              searchPolicy: {
                ...whitePolicy,
                maxNodes: 999,
              },
            },
          },
        },
      }],
    } as const;
    expect(() => {
      assertPlayerPrivateWorkerResponse(
        corrupted,
        assignedGames,
        policy,
        1,
      );
    }).toThrow("search provenance");

    const corruptedParameterSeed = {
      ...response,
      games: [{
        gameIndex: 0,
        result: {
          ...result,
          parameterSeeds: {
            ...result.parameterSeeds,
            white: (result.parameterSeeds.white + 1) >>> 0,
          },
        },
      }],
    } as const;
    expect(() => {
      assertPlayerPrivateWorkerResponse(
        corruptedParameterSeed,
        assignedGames,
        policy,
        1,
      );
    }).toThrow("parameter seeds");

    const forgedShortActive = {
      ...response,
      games: [{
        gameIndex: 0,
        result: {
          ...result,
          plies: [],
          finalFen: result.initialFen,
          result: { kind: "active" },
          stoppedAtPlyLimit: false,
        },
      }],
    } as const;
    expect(() => {
      assertPlayerPrivateWorkerResponse(
        forgedShortActive,
        assignedGames,
        policy,
        1,
      );
    }).toThrow("stoppedAtPlyLimit");

    const forgedCapture = {
      ...response,
      games: [{
        gameIndex: 0,
        result: {
          ...result,
          result: { kind: "king-capture" },
          stoppedAtPlyLimit: false,
        },
      }],
    } as const;
    expect(() => {
      assertPlayerPrivateWorkerResponse(
        forgedCapture,
        assignedGames,
        policy,
        1,
      );
    }).toThrow("invalid fields");
  });
});
