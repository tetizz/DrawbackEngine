import { parentPort, workerData } from "node:worker_threads";
import {
  createNodeUciTurnConstraintProvider,
} from "@drawbackengine/chess-evaluator";
import { deriveGameSeed } from "./batch.js";
import {
  resolveCatalogAgent,
  resolveCatalogRule,
  simulateCatalogGame,
} from "./catalog.js";
import { simulateGame } from "./simulation.js";
import {
  simulatePreparedCatalogAssignedGame,
  simulatePreparedCatalogGame,
} from "./prepared-catalog.js";
import {
  assertParallelWorkerRequest,
  type ParallelWorkerRequest,
  type ParallelWorkerResponse,
} from "./parallel.js";

async function run(
  request: ParallelWorkerRequest,
): Promise<ParallelWorkerResponse> {
  assertParallelWorkerRequest(request);
  if ("kind" in request) {
    const provider = await createNodeUciTurnConstraintProvider(
      request.evaluator,
    );
    try {
      const games: ParallelWorkerResponse["games"][number][] = [];
      if (request.kind === "prepared-catalog-assignments") {
        for (const { gameIndex, assignment } of request.assignedGames) {
          games.push({
            gameIndex,
            result: await simulatePreparedCatalogAssignedGame(
              assignment,
              provider,
              request.maxPlies === undefined
                ? {}
                : { maxPlies: request.maxPlies },
            ),
          });
        }
      } else {
        for (const { gameIndex, seed } of request.seededGames) {
          games.push({
            gameIndex,
            result: await simulatePreparedCatalogGame(
              seed,
              provider,
              request.catalog,
            ),
          });
        }
      }
      return { games };
    } finally {
      await provider.dispose();
    }
  }
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
    await run(workerData as ParallelWorkerRequest),
  );
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown worker failure.";
  throw new Error(`Parallel simulation worker failed: ${message}`, { cause: error });
}
