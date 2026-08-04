import type {
  PlayerPrivateSimulationResult,
} from "./player-private-simulation.js";
import {
  assertPlayerPrivateGameAssignment,
  assertPlayerPrivateSearchPolicy,
  assertPositiveSafeInteger,
  type PlayerPrivateAssignmentBatchRequest,
} from "./player-private-parallel-protocol.js";
import { createPlayerPrivateWorkerPool } from "./player-private-worker-pool.js";

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
  const pool = await createPlayerPrivateWorkerPool({
    workers: Math.min(request.workers, immutableAssignments.length),
    policy: immutablePolicy,
    ...(request.maxPlies === undefined
      ? {}
      : { maxPlies: request.maxPlies }),
  });
  const operation = await (async () => {
    const indexed = await pool.runBatch(
      immutableAssignments.map((assignment, gameIndex) =>
        Object.freeze({ gameIndex, assignment })
      ),
    );
    return Object.freeze(indexed.map((item, expectedIndex) => {
      if (item.gameIndex !== expectedIndex) {
        throw new Error(
          "Player-private workers returned duplicate or missing indexes.",
        );
      }
      return item.result;
    }));
  })().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const cleanup = await pool.close().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!operation.ok && !cleanup.ok) {
    throw new AggregateError(
      [operation.error, cleanup.error],
      "Player-private simulation and retained pool cleanup both failed.",
    );
  }
  if (!operation.ok) {
    throw operation.error;
  }
  if (!cleanup.ok) {
    throw cleanup.error;
  }
  return operation.value;
}

function freezeRecursively<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    // The enclosing policy is an owned structured clone. Non-empty typed
    // arrays cannot be frozen by JavaScript, but no caller retains this view.
    return value;
  }
  for (const child of Object.values(value)) {
    freezeRecursively(child);
  }
  return Object.freeze(value);
}
