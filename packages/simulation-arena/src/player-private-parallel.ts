import { Worker } from "node:worker_threads";
import type {
  PlayerPrivateSimulationResult,
} from "./player-private-simulation.js";
import {
  assertPlayerPrivateGameAssignment,
  assertPlayerPrivateSearchPolicy,
  assertPositiveSafeInteger,
  type PlayerPrivateAssignmentBatchRequest,
  type PlayerPrivateGameAssignment,
  type PlayerPrivateWorkerRequest,
  type PlayerPrivateWorkerResponse,
} from "./player-private-parallel-protocol.js";
import {
  assertPlayerPrivateWorkerResponse,
} from "./player-private-result-validation.js";
import { retryParallelWorkerOperation } from "./worker-retry.js";

export {
  assertPlayerPrivateWorkerRequest,
} from "./player-private-parallel-protocol.js";
export {
  assertPlayerPrivateWorkerResponse,
} from "./player-private-result-validation.js";
export type {
  PlayerPrivateAssignmentBatchRequest,
  PlayerPrivateGameAssignment,
  PlayerPrivateSearchPolicy,
  PlayerPrivateWorkerRequest,
  PlayerPrivateWorkerResponse,
} from "./player-private-parallel-protocol.js";

export async function simulatePlayerPrivateAssignmentsParallel(
  request: PlayerPrivateAssignmentBatchRequest,
): Promise<readonly PlayerPrivateSimulationResult[]> {
  assertPositiveSafeInteger(request.workers, "workers");
  assertPlayerPrivateSearchPolicy(request.policy);
  if (request.assignments.length === 0) {
    return [];
  }
  if (request.maxPlies !== undefined) {
    assertPositiveSafeInteger(request.maxPlies, "maxPlies");
  }
  const seeds = request.assignments.map(({ seed }) => seed);
  if (new Set(seeds).size !== seeds.length) {
    throw new RangeError(
      "Player-private assignment seeds must be unique.",
    );
  }
  for (const assignment of request.assignments) {
    assertPlayerPrivateGameAssignment(assignment);
  }
  const immutableAssignments = freezeRecursively(
    structuredClone([...request.assignments]),
  );
  const immutablePolicy = freezeRecursively(
    structuredClone(request.policy),
  );
  const workerCount = Math.min(request.workers, immutableAssignments.length);
  const shards = Array.from(
    { length: workerCount },
    (): {
      gameIndex: number;
      assignment: PlayerPrivateGameAssignment;
    }[] => [],
  );
  immutableAssignments.forEach((assignment, gameIndex) => {
    shards[gameIndex % workerCount]?.push({ gameIndex, assignment });
  });
  const responses = await Promise.all(
    shards.map((assignedGames) =>
      runWorker({
        schemaVersion: 1,
        kind: "player-private-assignments",
        assignedGames,
        policy: immutablePolicy,
        ...(request.maxPlies === undefined
          ? {}
          : { maxPlies: request.maxPlies }),
      })
    ),
  );
  const indexed = responses
    .flatMap(({ games }) => games)
    .sort((left, right) => left.gameIndex - right.gameIndex);
  if (indexed.length !== immutableAssignments.length) {
    throw new Error(
      "Player-private workers returned an incomplete game batch.",
    );
  }
  return Object.freeze(indexed.map((item, expectedIndex) => {
    if (item.gameIndex !== expectedIndex) {
      throw new Error(
        "Player-private workers returned duplicate or missing indexes.",
      );
    }
    return item.result;
  }));
}

function runWorker(
  request: PlayerPrivateWorkerRequest,
): Promise<PlayerPrivateWorkerResponse> {
  return retryParallelWorkerOperation(() => runWorkerOnce(request));
}

function runWorkerOnce(
  request: PlayerPrivateWorkerRequest,
): Promise<PlayerPrivateWorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerEntry(), {
      workerData: request,
      execArgv: import.meta.url.endsWith(".ts")
        ? ["--import", sourceLoader()]
        : [],
    });
    let settled = false;
    const cleanup = (): void => {
      worker.removeAllListeners("message");
      worker.removeAllListeners("error");
      worker.removeAllListeners("exit");
    };
    worker.once("message", (response: unknown) => {
      try {
        assertPlayerPrivateWorkerResponse(
          response,
          request.assignedGames,
          request.policy,
          request.maxPlies,
        );
        settled = true;
        cleanup();
        resolve(response);
      } catch (error) {
        settled = true;
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new Error("Player-private response validation failed."),
        );
      }
    });
    worker.once("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new Error("Player-private worker failed."),
        );
      }
    });
    worker.once("exit", (code) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new Error(
            `Player-private worker exited before responding with code ${String(code)}.`,
          ),
        );
      }
    });
  });
}

function freezeRecursively<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const child of Object.values(value)) {
    freezeRecursively(child);
  }
  return Object.freeze(value);
}

function workerEntry(): URL {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(
    `./player-private-parallel-worker.${extension}`,
    import.meta.url,
  );
}

function sourceLoader(): string {
  return new URL(
    "../node_modules/tsx/dist/loader.mjs",
    import.meta.url,
  ).href;
}
