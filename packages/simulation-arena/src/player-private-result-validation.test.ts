import { beforeAll, describe, expect, it } from "vitest";
import type {
  PlayerPrivateSimulationAgent,
} from "./player-private-agent.js";
import type {
  PlayerPrivateGameAssignment,
  PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";
import {
  assertPlayerPrivateWorkerResponse,
  assertPlayerPrivateWorkerTaskResult,
} from "./player-private-result-validation.js";
import {
  resolvePlayerPrivateRule,
} from "./player-private-catalog.js";
import {
  simulatePlayerPrivateGame,
  type PlayerPrivateSimulationPly,
  type PlayerPrivateSimulationResult,
} from "./player-private-simulation.js";
import type {
  PlayerPrivateWorkerIdentity,
} from "./player-private-worker-protocol.js";

const ACTIVE_PLY_LIMIT = 4;
const TERMINAL_PLY_LIMIT = 2;

const policy = {
  policyId: "result-replay-test",
  maxDepth: 1,
  maxNodes: 64,
  temperatureCp: 1,
  leafCacheEntries: 128,
  leafCacheHistoryMode: "full",
  opponentAggregation: "worst-case",
  evaluator: {
    kind: "material",
    version: 1,
  },
  opponentHypotheses: {
    kind: "unrestricted-baseline",
    version: 1,
  },
} as const satisfies PlayerPrivateSearchPolicy;

const deterministicAgent: PlayerPrivateSimulationAgent = {
  id: policy.policyId,
  style: "drawback-search",
  searchPolicy: {
    policyId: policy.policyId,
    evaluatorId: "drawback-material/v1",
    maxDepth: policy.maxDepth,
    maxNodes: policy.maxNodes,
    leafCacheEntries: policy.leafCacheEntries,
    leafCacheHistoryMode: policy.leafCacheHistoryMode,
    opponentAggregation: policy.opponentAggregation,
    temperatureCp: policy.temperatureCp,
    topK: null,
  },
  chooseMove(view) {
    const move =
      view.legalMoves.find((candidate) => candidate.captured === "king")
      ?? view.legalMoves[0];
    if (move === undefined) {
      throw new Error("Expected a deterministic legal move.");
    }
    return Promise.resolve(move);
  },
};

const activeAssignment = {
  seed: 0x1234_5678,
  parameterSeeds: {
    white: 0x1111_2222,
    black: 0x3333_4444,
  },
  whiteRuleId: "truant",
  blackRuleId: "spice-of-life",
} as const satisfies PlayerPrivateGameAssignment;

const terminalAssignment = {
  seed: 0x8765_4321,
  parameterSeeds: {
    white: 0x5555_6666,
    black: 0x7777_8888,
  },
  whiteRuleId: "vegan",
  blackRuleId: "vegan",
  initialFen: "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
} as const satisfies PlayerPrivateGameAssignment;

const identity = {
  poolId: "result-replay-pool",
  workerId: 2,
  generation: 3,
  authenticationToken: "result-replay-auth-token",
} as const satisfies PlayerPrivateWorkerIdentity;

let activeResult: PlayerPrivateSimulationResult | undefined;
let terminalResult: PlayerPrivateSimulationResult | undefined;

beforeAll(async () => {
  activeResult = await simulatePlayerPrivateGame({
    seed: activeAssignment.seed,
    parameterSeeds: activeAssignment.parameterSeeds,
    rules: {
      white: resolvePlayerPrivateRule(activeAssignment.whiteRuleId),
      black: resolvePlayerPrivateRule(activeAssignment.blackRuleId),
    },
    whiteAgent: deterministicAgent,
    blackAgent: deterministicAgent,
    maxPlies: ACTIVE_PLY_LIMIT,
  });
  terminalResult = await simulatePlayerPrivateGame({
    seed: terminalAssignment.seed,
    parameterSeeds: terminalAssignment.parameterSeeds,
    rules: {
      white: resolvePlayerPrivateRule(terminalAssignment.whiteRuleId),
      black: resolvePlayerPrivateRule(terminalAssignment.blackRuleId),
    },
    whiteAgent: deterministicAgent,
    blackAgent: deterministicAgent,
    maxPlies: TERMINAL_PLY_LIMIT,
    fen: terminalAssignment.initialFen,
  });
});

describe("player-private worker result semantic authentication", () => {
  it("accepts valid active and terminal authority replays", () => {
    expect(() => {
      assertLegacyResult(
        structuredClone(requiredActiveResult()),
        activeAssignment,
        ACTIVE_PLY_LIMIT,
      );
      assertPersistentResult(
        structuredClone(requiredTerminalResult()),
        terminalAssignment,
        TERMINAL_PLY_LIMIT,
      );
    }).not.toThrow();
    expect(requiredActiveResult().result).toEqual({ kind: "active" });
    expect(requiredTerminalResult().result).toEqual({
      kind: "king-capture",
      winner: "white",
      capturedKing: "black",
      method: "direct",
    });
  });

  it("rejects a forged z9 move through the persistent-worker path", () => {
    const result = requiredActiveResult();
    const first = requiredPly(result, 0);
    const forged = replacePly(result, 0, {
      ...first,
      observation: {
        ...first.observation,
        move: {
          ...first.observation.move,
          from: "z9",
        },
      },
    });

    expect(() => {
      assertPersistentResult(
        forged,
        activeAssignment,
        ACTIVE_PLY_LIMIT,
      );
    }).toThrow(/move is rejected by authoritative replay/u);
  });

  it.each([
    {
      name: "authority-legal mask",
      mutate: (first: PlayerPrivateSimulationPly) => ({
        ...first.observation,
        authorityLegalMoves:
          first.observation.authorityLegalMoves.slice(1),
      }),
      error: /authority-legal mask does not match authoritative replay/u,
    },
    {
      name: "drawback-legal mask",
      mutate: (first: PlayerPrivateSimulationPly) => ({
        ...first.observation,
        drawbackLegalMoves:
          first.observation.drawbackLegalMoves.slice(1),
      }),
      error: /drawback-legal mask does not match authoritative replay/u,
    },
    {
      name: "observation trigger claim",
      mutate: (first: PlayerPrivateSimulationPly) => ({
        ...first.observation,
        ruleTriggered: !first.observation.ruleTriggered,
      }),
      error: /observation does not match authoritative replay/u,
    },
  ])("rejects a forged $name", ({ mutate, error }) => {
    const result = requiredActiveResult();
    const first = requiredPly(result, 0);
    const forged = replacePly(result, 0, {
      ...first,
      observation: mutate(first),
    });

    expect(() => {
      assertLegacyResult(forged, activeAssignment, ACTIVE_PLY_LIMIT);
    }).toThrow(error);
  });

  it("rejects structurally continuous forged FEN claims", () => {
    const result = requiredTerminalResult();
    const first = requiredPly(result, 0);
    const forged = {
      ...replacePly(result, 0, {
        ...first,
        observation: {
          ...first.observation,
          fenAfter: result.initialFen,
        },
      }),
      finalFen: result.initialFen,
    };

    expect(() => {
      assertLegacyResult(
        forged,
        terminalAssignment,
        TERMINAL_PLY_LIMIT,
      );
    }).toThrow(/observation does not match authoritative replay/u);
  });

  it.each([
    {
      name: "initial secret",
      forge: (result: PlayerPrivateSimulationResult) => ({
        ...result,
        drawbackSecrets: {
          ...result.drawbackSecrets,
          initial: {
            ...result.drawbackSecrets.initial,
            white: {
              ...result.drawbackSecrets.initial.white,
              state: { forged: true },
            },
          },
        },
      }),
      error: /initial secrets do not match authoritative replay/u,
    },
    {
      name: "active-ply secret",
      forge: (result: PlayerPrivateSimulationResult) => {
        const first = requiredPly(result, 0);
        return replacePly(result, 0, {
          ...first,
          drawback: {
            ...first.drawback,
            state: { forged: true },
          },
        });
      },
      error: /active secret does not match authoritative replay/u,
    },
    {
      name: "final secret",
      forge: (result: PlayerPrivateSimulationResult) => ({
        ...result,
        drawbackSecrets: {
          ...result.drawbackSecrets,
          final: {
            ...result.drawbackSecrets.final,
            black: {
              ...result.drawbackSecrets.final.black,
              state: { forged: true },
            },
          },
        },
      }),
      error: /final secrets do not match authoritative replay/u,
    },
  ])("rejects a forged $name snapshot", ({ forge, error }) => {
    expect(() => {
      assertLegacyResult(
        forge(requiredActiveResult()),
        activeAssignment,
        ACTIVE_PLY_LIMIT,
      );
    }).toThrow(error);
  });

  it("rejects a structurally valid forged terminal claim", () => {
    const result = requiredTerminalResult();
    const forged = {
      ...result,
      result: {
        kind: "king-capture",
        winner: "black",
        capturedKing: "white",
        method: "direct",
      },
    };

    expect(() => {
      assertLegacyResult(
        forged,
        terminalAssignment,
        TERMINAL_PLY_LIMIT,
      );
    }).toThrow(/terminal result does not match authoritative replay/u);
  });

  it("rejects a structurally continuous ply after the game ended", () => {
    const result = requiredTerminalResult();
    const first = requiredPly(result, 0);
    const extra = {
      ply: 1,
      color: "black",
      observation: {
        ...first.observation,
        fenBefore: result.finalFen,
        fenAfter: result.finalFen,
        move: {
          ...first.observation.move,
          color: "black",
        },
      },
      drawback: result.drawbackSecrets.final.black,
    };
    const forged = {
      ...result,
      plies: [first, extra],
    };

    expect(() => {
      assertLegacyResult(
        forged,
        terminalAssignment,
        TERMINAL_PLY_LIMIT,
      );
    }).toThrow(/occurs after the authoritative game ended/u);
  });
});

function requiredActiveResult(): PlayerPrivateSimulationResult {
  if (activeResult === undefined) {
    throw new Error("Expected the active replay fixture.");
  }
  return activeResult;
}

function requiredTerminalResult(): PlayerPrivateSimulationResult {
  if (terminalResult === undefined) {
    throw new Error("Expected the terminal replay fixture.");
  }
  return terminalResult;
}

function requiredPly(
  result: PlayerPrivateSimulationResult,
  index: number,
): PlayerPrivateSimulationPly {
  const ply = result.plies[index];
  if (ply === undefined) {
    throw new Error(`Expected replay ply ${String(index)}.`);
  }
  return ply;
}

function replacePly(
  result: PlayerPrivateSimulationResult,
  index: number,
  replacement: unknown,
): Omit<PlayerPrivateSimulationResult, "plies"> & {
  readonly plies: readonly unknown[];
} {
  return {
    ...result,
    plies: result.plies.map((ply, plyIndex) =>
      plyIndex === index ? replacement : ply
    ),
  };
}

function assertLegacyResult(
  result: unknown,
  assignment: PlayerPrivateGameAssignment,
  maxPlies: number,
): void {
  assertPlayerPrivateWorkerResponse(
    {
      schemaVersion: 1,
      kind: "player-private-results",
      games: [{ gameIndex: 0, result }],
    },
    [{ gameIndex: 0, assignment }],
    policy,
    maxPlies,
  );
}

function assertPersistentResult(
  result: unknown,
  assignment: PlayerPrivateGameAssignment,
  maxPlies: number,
): void {
  assertPlayerPrivateWorkerTaskResult(
    {
      schemaVersion: 2,
      kind: "player-private-worker-task-result",
      ...identity,
      taskId: 17,
      attempt: 1,
      games: [{ gameIndex: 0, result }],
    },
    identity,
    17,
    1,
    [{ gameIndex: 0, assignment }],
    policy,
    maxPlies,
  );
}
