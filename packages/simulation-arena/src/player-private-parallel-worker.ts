import { parentPort, workerData } from "node:worker_threads";
import {
  drawbackMaterialEvaluator,
} from "@drawbackengine/drawback-search";
import { createPlayerPrivateSearchAgent } from "./player-private-agent.js";
import {
  assertPlayerPrivateWorkerRequest,
  type PlayerPrivateSearchPolicy,
  type PlayerPrivateWorkerRequest,
  type PlayerPrivateWorkerResponse,
} from "./player-private-parallel-protocol.js";
import {
  resolvePlayerPrivateRule,
} from "./player-private-catalog.js";
import {
  auditedUniformOpponentHypotheses,
  simulatePlayerPrivateGame,
  unrestrictedOpponentHypotheses,
} from "./player-private-simulation.js";

async function run(
  request: PlayerPrivateWorkerRequest,
): Promise<PlayerPrivateWorkerResponse> {
  assertPlayerPrivateWorkerRequest(request);
  const agent = createAgent(request.policy);
  const games: PlayerPrivateWorkerResponse["games"][number][] = [];
  for (const { gameIndex, assignment } of request.assignedGames) {
    try {
      games.push({
        gameIndex,
        result: await simulatePlayerPrivateGame({
          seed: assignment.seed,
          parameterSeeds: assignment.parameterSeeds,
          rules: {
            white: resolvePlayerPrivateRule(assignment.whiteRuleId),
            black: resolvePlayerPrivateRule(assignment.blackRuleId),
          },
          whiteAgent: agent,
          blackAgent: agent,
          opponentHypotheses:
            request.policy.opponentHypotheses.kind === "audited-uniform"
              ? auditedUniformOpponentHypotheses
              : unrestrictedOpponentHypotheses,
          ...(assignment.initialFen === undefined
            ? {}
            : { fen: assignment.initialFen }),
          ...(request.maxPlies === undefined
            ? {}
            : { maxPlies: request.maxPlies }),
        }),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown game failure.";
      throw new Error(
        `Assignment ${String(gameIndex)} `
          + `(${assignment.whiteRuleId} vs ${assignment.blackRuleId}) `
          + `failed: ${message}`,
        { cause: error },
      );
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "player-private-results",
    games: Object.freeze(games),
  });
}

function createAgent(policy: PlayerPrivateSearchPolicy) {
  return createPlayerPrivateSearchAgent({
    id: policy.policyId,
    policyId: policy.policyId,
    evaluator: drawbackMaterialEvaluator,
    opponentAggregation:
      policy.opponentAggregation ?? "worst-case",
    limits: {
      maxDepth: policy.maxDepth,
      maxNodes: policy.maxNodes,
      ...(policy.leafCacheEntries === undefined
        ? {}
        : { leafCacheEntries: policy.leafCacheEntries }),
      ...(policy.leafCacheHistoryMode === undefined
        ? {}
        : { leafCacheHistoryMode: policy.leafCacheHistoryMode }),
    },
    temperature: {
      temperatureCp: policy.temperatureCp,
      ...(policy.topK === undefined ? {} : { topK: policy.topK }),
    },
  });
}

if (parentPort === null) {
  throw new Error("Player-private simulation worker requires a parent port.");
}

try {
  parentPort.postMessage(
    await run(workerData as PlayerPrivateWorkerRequest),
  );
} catch (error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unknown worker failure.";
  throw new Error(
    `Player-private simulation worker failed: ${message}`,
    { cause: error },
  );
}
