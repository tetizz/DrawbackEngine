import { Worker } from "node:worker_threads";
import {
  AuthenticatedNodeUciEngineCloseError,
  createNodeUciTurnConstraintProvider,
  errorProvesUciProcessTerminated,
  type NodeUciTurnConstraintProviderConfig,
  type UciTurnConstraintProvider,
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
import {
  PREPARED_EXECUTABLE_RULE_IDS,
  simulatePreparedCatalogAssignedGame,
  simulatePreparedCatalogGame,
} from "./prepared-catalog.js";
import {
  TransientParallelWorkerError,
  retryParallelWorkerOperation,
} from "./worker-retry.js";

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
    };

export interface ParallelWorkerResponse {
  readonly games: readonly IndexedSimulationResult[];
}

/** Prepared evaluator cleanup remains owned and retryable by the caller. */
export class PreparedEvaluatorCleanupError extends AggregateError {
  public readonly cleanupComplete = false;

  public constructor(
    failures: readonly unknown[],
    private readonly provider: UciTurnConstraintProvider,
  ) {
    super(
      failures,
      "Parent-owned prepared evaluator cleanup remains incomplete.",
    );
    this.name = "PreparedEvaluatorCleanupError";
  }

  public async retryCleanup(): Promise<void> {
    try {
      await disposePreparedProvider(this.provider);
    } catch (error: unknown) {
      if (error instanceof PreparedEvaluatorCleanupError) {
        throw new PreparedEvaluatorCleanupError(
          [...this.errors as readonly unknown[], ...error.errors as readonly unknown[]],
          this.provider,
        );
      }
      throw new AggregateError(
        [...this.errors as readonly unknown[], error],
        "Prepared evaluator cleanup completed abnormally after a retained retry.",
      );
    }
  }
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
    worker.once("message", (value: unknown) => {
      try {
        assertParallelWorkerResponse(value);
        settled = true;
        cleanup();
        resolve(value);
      } catch (error: unknown) {
        settled = true;
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new TypeError("Parallel worker response validation failed."),
        );
      }
    });
    worker.once("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new TransientParallelWorkerError(
            "worker-process-error",
            "Parallel simulation worker process failed.",
            { cause: error },
          ),
        );
      }
    });
    worker.once("exit", (code) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new TransientParallelWorkerError(
            "worker-process-exit",
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

export function assertParallelWorkerResponse(
  value: unknown,
): asserts value is ParallelWorkerResponse {
  const response = taggedObject(value, "parallel worker response");
  exactObjectKeys(response, ["games"], "parallel worker response");
  if (!Array.isArray(response["games"])) {
    throw new TypeError(
      "parallel worker response games must be an array.",
    );
  }
}

export function assertParallelWorkerRequest(
  value: unknown,
): asserts value is ParallelWorkerRequest {
  const request = taggedObject(value, "parallel worker request");
  if (Object.hasOwn(request, "kind")) {
    throw new TypeError(
      "Prepared evaluator requests are parent-owned and cannot cross the worker boundary.",
    );
  }
  if (Object.hasOwn(request, "seededGames")) {
    exactObjectKeys(request, ["seededGames", "catalog"], "seeded worker request");
    return;
  }
  if (Object.hasOwn(request, "catalog")) {
    exactObjectKeys(
      request,
      ["batchSeed", "gameIndexes", "catalog"],
      "catalog worker request",
    );
    return;
  }
  exactObjectKeys(
    request,
    ["batchSeed", "gameIndexes", "spec"],
    "simulation worker request",
  );
}

export async function simulatePreparedCatalogSeedsParallel(
  request: PreparedCatalogSeedBatchRequest,
): Promise<readonly SimulationResult[]> {
  positiveSafeInteger(request.workers, "workers");
  const seeds = [...request.seeds];
  if (seeds.length === 0) {
    return [];
  }
  if (new Set(seeds).size !== seeds.length) {
    throw new RangeError("explicit prepared game seeds must be unique.");
  }
  const catalog = snapshotPreparedCatalogOptions(request);
  const evaluator = structuredClone(request.evaluator);
  const workerCount = Math.min(seeds.length, request.workers);
  const assignments = Array.from(
    { length: workerCount },
    (): { gameIndex: number; seed: number }[] => [],
  );
  seeds.forEach((seed, gameIndex) => {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError("prepared game seeds must be unsigned 32-bit integers.");
    }
    assignments[gameIndex % workerCount]?.push({ gameIndex, seed });
  });
  const responses = await settlePreparedShards(
    assignments.map((seededGames) =>
      runPreparedParentShard(evaluator, async (provider) => {
        const games: ParallelWorkerResponse["games"][number][] = [];
        for (const { gameIndex, seed } of seededGames) {
          games.push({
            gameIndex,
            result: await simulatePreparedCatalogGame(
              seed,
              provider,
              catalog,
            ),
          });
        }
        return { games };
      }),
    ),
  );
  const indexed = responses
    .flatMap((response) => response.games)
    .sort((left, right) => left.gameIndex - right.gameIndex);
  if (indexed.length !== seeds.length) {
    throw new Error("Prepared evaluator shards returned an incomplete game batch.");
  }
  return indexed.map((item, expectedIndex) => {
    if (item.gameIndex !== expectedIndex) {
      throw new Error(
        "Prepared evaluator shards returned duplicate or missing indexes.",
      );
    }
    return item.result;
  });
}

function runWorker(
  request: ParallelWorkerRequest,
): Promise<ParallelWorkerResponse> {
  return retryParallelWorkerOperation(() => runWorkerOnce(request));
}

async function runPreparedParentShard(
  evaluator: NodeUciTurnConstraintProviderConfig,
  operation: (
    provider: UciTurnConstraintProvider,
  ) => Promise<ParallelWorkerResponse>,
): Promise<ParallelWorkerResponse> {
  const provider = await createNodeUciTurnConstraintProvider(evaluator);
  const outcome = await operation(provider).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const cleanup = await disposePreparedProvider(provider).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!outcome.ok && !cleanup.ok) {
    throw new AggregateError(
      [outcome.error, cleanup.error],
      "Prepared simulation and evaluator cleanup both failed.",
    );
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  if (!cleanup.ok) {
    throw cleanup.error;
  }
  return outcome.value;
}

async function disposePreparedProvider(
  provider: UciTurnConstraintProvider,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await provider.dispose();
  } catch (firstFailure: unknown) {
    failures.push(firstFailure);
    if (preparedCleanupIsComplete(firstFailure)) {
      throw firstFailure;
    }
    try {
      await provider.dispose();
    } catch (secondFailure: unknown) {
      failures.push(secondFailure);
      if (!preparedCleanupIsComplete(secondFailure)) {
        throw new PreparedEvaluatorCleanupError(failures, provider);
      }
      throw new AggregateError(
        failures,
        "Parent-owned prepared evaluator cleanup completed abnormally after retry.",
      );
    }
  }
}

function preparedCleanupIsComplete(error: unknown): boolean {
  if (error instanceof AuthenticatedNodeUciEngineCloseError) {
    return error.privateExecutableRemoved && error.processTerminated;
  }
  return errorProvesUciProcessTerminated(error);
}

export async function simulatePreparedCatalogAssignmentsParallel(
  request: PreparedCatalogAssignmentBatchRequest,
): Promise<readonly SimulationResult[]> {
  positiveSafeInteger(request.workers, "workers");
  const immutableAssignments = snapshotPreparedAssignments(request.assignments);
  if (immutableAssignments.length === 0) {
    return [];
  }
  if (request.maxPlies !== undefined) {
    positiveSafeInteger(request.maxPlies, "maxPlies");
  }
  const maxPlies = request.maxPlies;
  const evaluator = structuredClone(request.evaluator);
  const seeds = immutableAssignments.map((assignment) => assignment.seed);
  if (new Set(seeds).size !== seeds.length) {
    throw new RangeError("explicit prepared assignment seeds must be unique.");
  }
  const workerCount = Math.min(immutableAssignments.length, request.workers);
  const assignments = Array.from(
    { length: workerCount },
    (): {
      gameIndex: number;
      assignment: PreparedCatalogGameAssignment;
    }[] => [],
  );
  immutableAssignments.forEach((assignment, gameIndex) => {
    assignments[gameIndex % workerCount]?.push({ gameIndex, assignment });
  });
  const responses = await settlePreparedShards(
    assignments.map((assignedGames) =>
      runPreparedParentShard(evaluator, async (provider) => {
        const games: ParallelWorkerResponse["games"][number][] = [];
        for (const { gameIndex, assignment } of assignedGames) {
          games.push({
            gameIndex,
            result: await simulatePreparedCatalogAssignedGame(
              assignment,
              provider,
              maxPlies === undefined
                ? {}
                : { maxPlies },
            ),
          });
        }
        return { games };
      }),
    ),
  );
  const indexed = responses
    .flatMap((response) => response.games)
    .sort((left, right) => left.gameIndex - right.gameIndex);
  if (indexed.length !== immutableAssignments.length) {
    throw new Error(
      "Prepared assignment evaluator shards returned an incomplete batch.",
    );
  }
  return indexed.map((item, expectedIndex) => {
    if (item.gameIndex !== expectedIndex) {
      throw new Error(
        "Prepared assignment evaluator shards returned duplicate or missing indexes.",
      );
    }
    return item.result;
  });
}

async function settlePreparedShards(
  shards: readonly Promise<ParallelWorkerResponse>[],
): Promise<readonly ParallelWorkerResponse[]> {
  const settled = await Promise.allSettled(shards);
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : []
  );
  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(
          failures,
          "Multiple parent-owned prepared evaluator shards failed.",
        );
  }
  return settled.map((result) => {
    if (result.status !== "fulfilled") {
      throw new Error("Prepared evaluator shard settlement was lost.");
    }
    return result.value;
  });
}

function snapshotPreparedCatalogOptions(
  options: PreparedCatalogSelectionOptions,
): PreparedCatalogSelectionOptions {
  if (options.maxPlies !== undefined) {
    positiveSafeInteger(options.maxPlies, "maxPlies");
  }
  const ruleIds = options.ruleIds === undefined
    ? undefined
    : [...options.ruleIds];
  const agentIds = options.agentIds === undefined
    ? undefined
    : [...options.agentIds];
  if (ruleIds !== undefined) {
    if (ruleIds.length === 0) {
      throw new RangeError("prepared rule selection cannot be empty.");
    }
    for (const ruleId of ruleIds) {
      if (!PREPARED_EXECUTABLE_RULE_IDS.includes(ruleId)) {
        throw new RangeError("prepared rule selection is outside the catalog.");
      }
    }
  }
  if (agentIds !== undefined) {
    if (agentIds.length === 0) {
      throw new RangeError("prepared agent selection cannot be empty.");
    }
    for (const agentId of agentIds) {
      if (!CATALOG_AGENT_IDS.includes(agentId)) {
        throw new RangeError("prepared agent selection is outside the catalog.");
      }
    }
  }
  return Object.freeze({
    ...(ruleIds === undefined ? {} : { ruleIds: Object.freeze(ruleIds) }),
    ...(agentIds === undefined ? {} : { agentIds: Object.freeze(agentIds) }),
    ...(options.maxPlies === undefined ? {} : { maxPlies: options.maxPlies }),
  });
}

function snapshotPreparedAssignments(
  assignments: readonly PreparedCatalogGameAssignment[],
): readonly PreparedCatalogGameAssignment[] {
  return Object.freeze(assignments.map((assignment) => {
    const record = taggedObject(assignment, "prepared game assignment");
    exactObjectKeys(
      record,
      [
        "seed",
        "whiteRuleId",
        "blackRuleId",
        "whiteAgentId",
        "blackAgentId",
      ],
      "prepared game assignment",
    );
    if (
      !Number.isSafeInteger(assignment.seed)
      || assignment.seed < 0
      || assignment.seed > 0xffff_ffff
    ) {
      throw new RangeError(
        "prepared assignment seeds must be unsigned 32-bit integers.",
      );
    }
    for (const ruleId of [
      assignment.whiteRuleId,
      assignment.blackRuleId,
    ]) {
      if (!PREPARED_EXECUTABLE_RULE_IDS.includes(ruleId)) {
        throw new RangeError("prepared assignment rule is outside the catalog.");
      }
    }
    for (const agentId of [
      assignment.whiteAgentId,
      assignment.blackAgentId,
    ]) {
      if (!CATALOG_AGENT_IDS.includes(agentId)) {
        throw new RangeError("prepared assignment agent is outside the catalog.");
      }
    }
    return Object.freeze({ ...assignment });
  }));
}
