import { parentPort, workerData } from "node:worker_threads";
import { deriveGameSeed } from "./batch.js";
import {
  resolveCatalogAgent,
  resolveCatalogRule,
  simulateCatalogGame,
} from "./catalog.js";
import { simulateGame } from "./simulation.js";
import {
  assertParallelWorkerRequest,
  type ParallelWorkerRequest,
  type ParallelWorkerResponse,
} from "./parallel.js";

function run(
  request: ParallelWorkerRequest,
): ParallelWorkerResponse {
  assertParallelWorkerRequest(request);
  if ("seededGames" in request) {
    return {
      games: request.seededGames.map(({ gameIndex, seed }) => ({
        gameIndex,
        result: simulateCatalogGame(seed, request.catalog),
      })),
    };
  }
  return {
    games: request.gameIndexes.map((gameIndex) => {
      const gameSeed = deriveGameSeed(request.batchSeed, gameIndex);
      if ("catalog" in request) {
        return {
          gameIndex,
          result: simulateCatalogGame(gameSeed, request.catalog),
        };
      }
      return {
        gameIndex,
        result: simulateGame({
          seed: gameSeed,
          rules: {
            white: resolveCatalogRule(request.spec.whiteRuleId),
            black: resolveCatalogRule(request.spec.blackRuleId),
          },
          whiteAgent: resolveCatalogAgent(request.spec.whiteAgentId),
          blackAgent: resolveCatalogAgent(request.spec.blackAgentId),
          ...(request.spec.maxPlies === undefined
            ? {}
            : { maxPlies: request.spec.maxPlies }),
        }),
      };
    }),
  };
}

if (parentPort === null) {
  throw new Error("Parallel simulation worker requires a parent port.");
}

try {
  parentPort.postMessage(
    run(workerData as ParallelWorkerRequest),
  );
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown worker failure.";
  throw new Error(`Parallel simulation worker failed: ${message}`, { cause: error });
}
