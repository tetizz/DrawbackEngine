import { Worker } from "node:worker_threads";
import type {
  NodeUciTurnConstraintProviderConfig,
} from "@drawbackengine/chess-evaluator";
import type { SimulationResult } from "./simulation.js";
import type {
  CatalogSelectionOptions,
  ExecutableRuleId,
  CatalogAgentId,
} from "./catalog.js";
import { CATALOG_AGENT_IDS } from "./catalog.js";
import type {
  PreparedCatalogGameAssignment,
  PreparedCatalogSelectionOptions,
} from "./prepared-catalog.js";
import { PREPARED_EXECUTABLE_RULE_IDS } from "./prepared-catalog.js";
import { retryParallelWorkerOperation } from "./worker-retry.js";

export type ParallelRuleId = ExecutableRuleId;
export type ParallelAgentId = CatalogAgentId;

export interface ParallelSimulationSpec {
  readonly whiteRuleId: ParallelRuleId;
  readonly blackRuleId: ParallelRuleId;
  readonly whiteAgentId: ParallelAgentId;
  readonly blackAgentId: ParallelAgentId;
  readonly maxPlies?: number;
}

export interface ParallelBatchRequest {
  readonly seed: number;
  readonly games: number;
  readonly workers: number;
  readonly spec: ParallelSimulationSpec;
}

export interface CatalogParallelBatchRequest extends CatalogSelectionOptions {
  readonly seed: number;
  readonly games: number;
  readonly workers: number;
}

export interface CatalogSeedBatchRequest extends CatalogSelectionOptions {
  readonly seeds: readonly number[];
  readonly workers: number;
}

export interface PreparedCatalogSeedBatchRequest
extends PreparedCatalogSelectionOptions {
  readonly seeds: readonly number[];
  readonly workers: number;
  readonly evaluator: NodeUciTurnConstraintProviderConfig;
}

export interface PreparedCatalogAssignmentBatchRequest {
  readonly assignments: readonly PreparedCatalogGameAssignment[];
  readonly workers: number;
  readonly evaluator: NodeUciTurnConstraintProviderConfig;
  readonly maxPlies?: number;
}

export interface IndexedSimulationResult {
  readonly gameIndex: number;
  readonly result: SimulationResult;
}

export type ParallelWorkerRequest =
  | {
      readonly batchSeed: number;
      readonly gameIndexes: readonly number[];
      readonly spec: ParallelSimulationSpec;
    }
  | {
      readonly batchSeed: number;
      readonly gameIndexes: readonly number[];
      readonly catalog: CatalogSelectionOptions;
    }
  | {
      readonly seededGames: readonly {
        readonly gameIndex: number;
        readonly seed: number;
      }[];
      readonly catalog: CatalogSelectionOptions;
    }
  | {
      readonly schemaVersion: 2;
      readonly kind: "prepared-catalog-seeds";
      readonly seededGames: readonly {
        readonly gameIndex: number;
        readonly seed: number;
      }[];
      readonly catalog: PreparedCatalogSelectionOptions;
      readonly evaluator: NodeUciTurnConstraintProviderConfig;
    }
  | {
      readonly schemaVersion: 3;
      readonly kind: "prepared-catalog-assignments";
      readonly assignedGames: readonly {
        readonly gameIndex: number;
        readonly assignment: PreparedCatalogGameAssignment;
      }[];
      readonly evaluator: NodeUciTurnConstraintProviderConfig;
      readonly maxPlies?: number;
    };

export interface ParallelWorkerResponse {
  readonly games: readonly IndexedSimulationResult[];
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function workerEntry(): URL {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./parallel-worker.${extension}`, import.meta.url);
}

function sourceLoader(): string {
  return new URL(
    "../node_modules/tsx/dist/loader.mjs",
    import.meta.url,
  ).href;
}

function runWorkerOnce(
  request: ParallelWorkerRequest,
): Promise<ParallelWorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerEntry(), {
      workerData: request,
      // Source execution uses the workspace's tsx loader. Compiled execution
      // naturally inherits an empty/ordinary execArgv and loads worker.js.
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
    worker.once("message", (response: ParallelWorkerResponse) => {
      settled = true;
      cleanup();
      resolve(response);
    });
    worker.once("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new Error("Parallel simulation worker failed."),
        );
      }
    });
    worker.once("exit", (code) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new Error(
            `Parallel simulation worker exited before responding with code ${String(code)}.`,
          ),
        );
      }
    });
  });
}

export async function simulateBatchParallel(
  request: ParallelBatchRequest,
): Promise<readonly SimulationResult[]> {
  positiveSafeInteger(request.games, "games");
  positiveSafeInteger(request.workers, "workers");
  const workerCount = Math.min(request.games, request.workers);
  const assignments = Array.from(
    { length: workerCount },
    (): number[] => [],
  );
  for (let gameIndex = 0; gameIndex < request.games; gameIndex += 1) {
    assignments[gameIndex % workerCount]?.push(gameIndex);
  }
  const responses = await Promise.all(
    assignments.map((gameIndexes) =>
      runWorker({
        batchSeed: request.seed,
        gameIndexes,
        spec: request.spec,
      }),
    ),
  );
  const indexed = responses
    .flatMap((response) => response.games)
    .sort((left, right) => left.gameIndex - right.gameIndex);
  if (indexed.length !== request.games) {
    throw new Error("Parallel workers returned an incomplete game batch.");
  }
  return indexed.map((item, expectedIndex) => {
    if (item.gameIndex !== expectedIndex) {
      throw new Error("Parallel workers returned duplicate or missing game indexes.");
    }
    return item.result;
  });
}

export async function simulateCatalogBatchParallel(
  request: CatalogParallelBatchRequest,
): Promise<readonly SimulationResult[]> {
  positiveSafeInteger(request.games, "games");
  positiveSafeInteger(request.workers, "workers");
  const workerCount = Math.min(request.games, request.workers);
  const assignments = Array.from(
    { length: workerCount },
    (): number[] => [],
  );
  for (let gameIndex = 0; gameIndex < request.games; gameIndex += 1) {
    assignments[gameIndex % workerCount]?.push(gameIndex);
  }
  const catalog: CatalogSelectionOptions = {
    ...(request.ruleIds === undefined ? {} : { ruleIds: request.ruleIds }),
    ...(request.agentIds === undefined ? {} : { agentIds: request.agentIds }),
    ...(request.maxPlies === undefined ? {} : { maxPlies: request.maxPlies }),
  };
  const responses = await Promise.all(
    assignments.map((gameIndexes) =>
      runWorker({
        batchSeed: request.seed,
        gameIndexes,
        catalog,
      }),
    ),
  );
  const indexed = responses
    .flatMap((response) => response.games)
    .sort((left, right) => left.gameIndex - right.gameIndex);
  if (indexed.length !== request.games) {
    throw new Error("Parallel workers returned an incomplete catalog batch.");
  }
  return indexed.map((item, expectedIndex) => {
    if (item.gameIndex !== expectedIndex) {
      throw new Error("Parallel catalog workers returned duplicate or missing indexes.");
    }
    return item.result;
  });
}

export async function simulateCatalogSeedsParallel(
  request: CatalogSeedBatchRequest,
): Promise<readonly SimulationResult[]> {
  positiveSafeInteger(request.workers, "workers");
  if (request.seeds.length === 0) {
    return [];
  }
  if (new Set(request.seeds).size !== request.seeds.length) {
    throw new RangeError("explicit catalog game seeds must be unique.");
  }
  const workerCount = Math.min(request.seeds.length, request.workers);
  const assignments = Array.from(
    { length: workerCount },
    (): { gameIndex: number; seed: number }[] => [],
  );
  request.seeds.forEach((seed, gameIndex) => {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError("catalog game seeds must be unsigned 32-bit integers.");
    }
    assignments[gameIndex % workerCount]?.push({ gameIndex, seed });
  });
  const catalog: CatalogSelectionOptions = {
    ...(request.ruleIds === undefined ? {} : { ruleIds: request.ruleIds }),
    ...(request.agentIds === undefined ? {} : { agentIds: request.agentIds }),
    ...(request.maxPlies === undefined ? {} : { maxPlies: request.maxPlies }),
  };
  const responses = await Promise.all(
    assignments.map((seededGames) =>
      runWorker({ seededGames, catalog }),
    ),
  );
  const indexed = responses
    .flatMap((response) => response.games)
    .sort((left, right) => left.gameIndex - right.gameIndex);
  if (indexed.length !== request.seeds.length) {
    throw new Error("Parallel explicit-seed workers returned an incomplete batch.");
  }
  return indexed.map((item, expectedIndex) => {
    if (item.gameIndex !== expectedIndex) {
      throw new Error("Parallel explicit-seed workers returned invalid indexes.");
    }
    return item.result;
  });
}

function exactObjectKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    throw new TypeError(`${label} has invalid fields.`);
  }
}

function taggedObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function assertParallelWorkerRequest(
  value: unknown,
): asserts value is ParallelWorkerRequest {
  const request = taggedObject(value, "parallel worker request");
  if (!Object.hasOwn(request, "kind")) {
    return;
  }
  if (
    request["kind"] === "prepared-catalog-seeds"
    && request["schemaVersion"] === 2
  ) {
    exactObjectKeys(
      request,
      ["schemaVersion", "kind", "seededGames", "catalog", "evaluator"],
      "prepared seed request",
    );
    return;
  }
  if (
    request["kind"] !== "prepared-catalog-assignments"
    || request["schemaVersion"] !== 3
  ) {
    throw new TypeError("parallel worker request schema/kind is unsupported.");
  }
  const expected = ["schemaVersion", "kind", "assignedGames", "evaluator"];
  if (request["maxPlies"] !== undefined) {
    expected.push("maxPlies");
    positiveSafeInteger(request["maxPlies"] as number, "maxPlies");
  }
  exactObjectKeys(request, expected, "prepared assignment request");
  if (
    !Array.isArray(request["assignedGames"])
    || request["assignedGames"].length === 0
  ) {
    throw new TypeError("assignedGames must be a non-empty array.");
  }
  const indexes = new Set<number>();
  for (const rawGame of request["assignedGames"]) {
    const game = taggedObject(rawGame, "assigned game");
    exactObjectKeys(game, ["gameIndex", "assignment"], "assigned game");
    const gameIndex = game["gameIndex"];
    if (
      !Number.isSafeInteger(gameIndex)
      || (gameIndex as number) < 0
      || indexes.has(gameIndex as number)
    ) {
      throw new RangeError(
        "assigned game indexes must be unique non-negative safe integers.",
      );
    }
    indexes.add(gameIndex as number);
    const assignment = taggedObject(game["assignment"], "game assignment");
    exactObjectKeys(
      assignment,
      [
        "seed",
        "whiteRuleId",
        "blackRuleId",
        "whiteAgentId",
        "blackAgentId",
      ],
      "game assignment",
    );
    const seed = assignment["seed"];
    if (
      !Number.isSafeInteger(seed)
      || (seed as number) < 0
      || (seed as number) > 0xffff_ffff
    ) {
      throw new RangeError("game assignment seed must be uint32.");
    }
    for (const key of ["whiteRuleId", "blackRuleId"] as const) {
      if (
        !PREPARED_EXECUTABLE_RULE_IDS.includes(
          assignment[key] as PreparedCatalogGameAssignment[typeof key],
        )
      ) {
        throw new RangeError(`${key} is outside the prepared catalog.`);
      }
    }
    for (const key of ["whiteAgentId", "blackAgentId"] as const) {
      if (
        !CATALOG_AGENT_IDS.includes(
          assignment[key] as CatalogAgentId,
        )
      ) {
        throw new RangeError(`${key} is outside the agent catalog.`);
      }
    }
  }
}

export async function simulatePreparedCatalogSeedsParallel(
  request: PreparedCatalogSeedBatchRequest,
): Promise<readonly SimulationResult[]> {
  positiveSafeInteger(request.workers, "workers");
  if (request.seeds.length === 0) {
    return [];
  }
  if (new Set(request.seeds).size !== request.seeds.length) {
    throw new RangeError("explicit prepared game seeds must be unique.");
  }
  const workerCount = Math.min(request.seeds.length, request.workers);
  const assignments = Array.from(
    { length: workerCount },
    (): { gameIndex: number; seed: number }[] => [],
  );
  request.seeds.forEach((seed, gameIndex) => {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError("prepared game seeds must be unsigned 32-bit integers.");
    }
    assignments[gameIndex % workerCount]?.push({ gameIndex, seed });
  });
  const catalog: PreparedCatalogSelectionOptions = {
    ...(request.ruleIds === undefined ? {} : { ruleIds: request.ruleIds }),
    ...(request.agentIds === undefined ? {} : { agentIds: request.agentIds }),
    ...(request.maxPlies === undefined ? {} : { maxPlies: request.maxPlies }),
  };
  const responses = await Promise.all(
    assignments.map((seededGames) =>
      runWorker({
        schemaVersion: 2,
        kind: "prepared-catalog-seeds",
        seededGames,
        catalog,
        evaluator: request.evaluator,
      }),
    ),
  );
  const indexed = responses
    .flatMap((response) => response.games)
    .sort((left, right) => left.gameIndex - right.gameIndex);
  if (indexed.length !== request.seeds.length) {
    throw new Error("Prepared workers returned an incomplete game batch.");
  }
  return indexed.map((item, expectedIndex) => {
    if (item.gameIndex !== expectedIndex) {
      throw new Error("Prepared workers returned duplicate or missing indexes.");
    }
    return item.result;
  });
}

function runWorker(
  request: ParallelWorkerRequest,
): Promise<ParallelWorkerResponse> {
  return retryParallelWorkerOperation(() => runWorkerOnce(request));
}

export async function simulatePreparedCatalogAssignmentsParallel(
  request: PreparedCatalogAssignmentBatchRequest,
): Promise<readonly SimulationResult[]> {
  positiveSafeInteger(request.workers, "workers");
  if (request.assignments.length === 0) {
    return [];
  }
  const seeds = request.assignments.map((assignment) => assignment.seed);
  if (new Set(seeds).size !== seeds.length) {
    throw new RangeError("explicit prepared assignment seeds must be unique.");
  }
  const workerCount = Math.min(request.assignments.length, request.workers);
  const assignments = Array.from(
    { length: workerCount },
    (): {
      gameIndex: number;
      assignment: PreparedCatalogGameAssignment;
    }[] => [],
  );
  request.assignments.forEach((assignment, gameIndex) => {
    if (
      !Number.isSafeInteger(assignment.seed)
      || assignment.seed < 0
      || assignment.seed > 0xffff_ffff
    ) {
      throw new RangeError(
        "prepared assignment seeds must be unsigned 32-bit integers.",
      );
    }
    assignments[gameIndex % workerCount]?.push({ gameIndex, assignment });
  });
  const responses = await Promise.all(
    assignments.map((assignedGames) =>
      runWorker({
        schemaVersion: 3,
        kind: "prepared-catalog-assignments",
        assignedGames,
        evaluator: request.evaluator,
        ...(request.maxPlies === undefined
          ? {}
          : { maxPlies: request.maxPlies }),
      }),
    ),
  );
  const indexed = responses
    .flatMap((response) => response.games)
    .sort((left, right) => left.gameIndex - right.gameIndex);
  if (indexed.length !== request.assignments.length) {
    throw new Error("Prepared assignment workers returned an incomplete batch.");
  }
  return indexed.map((item, expectedIndex) => {
    if (item.gameIndex !== expectedIndex) {
      throw new Error(
        "Prepared assignment workers returned duplicate or missing indexes.",
      );
    }
    return item.result;
  });
}
