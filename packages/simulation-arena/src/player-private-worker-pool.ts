import { randomUUID } from "node:crypto";
import {
  assertPlayerPrivateGameAssignment,
  assertPlayerPrivateSearchPolicy,
  assertPositiveSafeInteger,
  type IndexedPlayerPrivateAssignment,
  type IndexedPlayerPrivateResult,
  type PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";
import {
  type PlayerPrivateWorkerIdentity,
  type PlayerPrivateWorkerInitialization,
  type PlayerPrivateWorkerTask,
} from "./player-private-worker-protocol.js";
import {
  DEFAULT_PARALLEL_WORKER_ATTEMPTS,
  isTransientParallelWorkerError,
  retryParallelWorkerOperation,
} from "./worker-retry.js";
import {
  createNodePlayerPrivateWorker,
  type PlayerPrivateWorkerFactory,
} from "./player-private-worker-transport.js";
import {
  PlayerPrivateWorkerSlot,
} from "./player-private-worker-slot.js";

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface PlayerPrivateWorkerPoolOptions {
  readonly workers: number;
  readonly policy: PlayerPrivateSearchPolicy;
  readonly maxPlies?: number;
  readonly attempts?: number;
  readonly initializationTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  /**
   * An internal transport seam used by deterministic lifecycle tests.
   * Product callers use Node worker threads.
   */
  readonly workerFactory?: PlayerPrivateWorkerFactory;
}

export interface PlayerPrivateWorkerPoolDiagnostics {
  readonly configuredWorkers: number;
  readonly launches: number;
  readonly activeWorkers: number;
  readonly peakActiveWorkers: number;
  readonly completedTasks: number;
  readonly retriedTasks: number;
}

export interface PlayerPrivateWorkerPool {
  runBatch(
    assignedGames: readonly IndexedPlayerPrivateAssignment[],
  ): Promise<readonly IndexedPlayerPrivateResult[]>;
  diagnostics(): PlayerPrivateWorkerPoolDiagnostics;
  close(): Promise<void>;
}

export async function createPlayerPrivateWorkerPool(
  options: PlayerPrivateWorkerPoolOptions,
): Promise<PlayerPrivateWorkerPool> {
  assertPositiveSafeInteger(options.workers, "workers");
  assertPlayerPrivateSearchPolicy(options.policy);
  if (options.maxPlies !== undefined) {
    assertPositiveSafeInteger(options.maxPlies, "maxPlies");
  }
  const attempts = options.attempts ?? DEFAULT_PARALLEL_WORKER_ATTEMPTS;
  assertPositiveSafeInteger(attempts, "parallel worker attempts");
  const initializationTimeoutMs =
    options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  assertPositiveSafeInteger(
    initializationTimeoutMs,
    "worker initialization timeout",
  );
  assertPositiveSafeInteger(
    shutdownTimeoutMs,
    "worker shutdown timeout",
  );
  const pool = new FixedPlayerPrivateWorkerPool({
    workers: options.workers,
    policy: freezeRecursively(structuredClone(options.policy)),
    ...(options.maxPlies === undefined
      ? {}
      : { maxPlies: options.maxPlies }),
    attempts,
    initializationTimeoutMs,
    shutdownTimeoutMs,
    workerFactory:
      options.workerFactory ?? createNodePlayerPrivateWorker,
  });
  try {
    await pool.initialize();
    return pool;
  } catch (error: unknown) {
    await pool.close();
    throw error;
  }
}

interface ValidatedPoolOptions {
  readonly workers: number;
  readonly policy: PlayerPrivateSearchPolicy;
  readonly maxPlies?: number;
  readonly attempts: number;
  readonly initializationTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly workerFactory: PlayerPrivateWorkerFactory;
}

class FixedPlayerPrivateWorkerPool implements PlayerPrivateWorkerPool {
  private readonly poolId = `pool-${randomUUID()}-${randomUUID()}`;
  private readonly slots: Array<PlayerPrivateWorkerSlot | undefined>;
  private readonly generations: number[];
  private readonly liveSlots = new Set<PlayerPrivateWorkerSlot>();
  private nextTaskId = 0;
  private launchCount = 0;
  private activeWorkerCount = 0;
  private peakActiveWorkerCount = 0;
  private completedTaskCount = 0;
  private retriedTaskCount = 0;
  private batchInFlight = false;
  private closed = false;

  public constructor(private readonly options: ValidatedPoolOptions) {
    this.slots = Array.from(
      { length: options.workers },
      () => undefined,
    );
    this.generations = Array.from(
      { length: options.workers },
      () => 0,
    );
  }

  public async initialize(): Promise<void> {
    const starts = this.slots.map((_, workerId) =>
      this.startSlotWithRetries(workerId)
    );
    const settled = await Promise.allSettled(starts);
    const failure = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (failure !== undefined) {
      throw failure.reason;
    }
    settled.forEach((result, workerId) => {
      if (result.status !== "fulfilled") {
        throw new Error("Player-private worker initialization was lost.");
      }
      this.slots[workerId] = result.value;
    });
  }

  public async runBatch(
    assignedGames: readonly IndexedPlayerPrivateAssignment[],
  ): Promise<readonly IndexedPlayerPrivateResult[]> {
    if (this.closed) {
      throw new Error("Player-private worker pool is closed.");
    }
    if (this.batchInFlight) {
      throw new Error(
        "Player-private worker pool accepts one ordered batch at a time.",
      );
    }
    const immutableGames = validateAndSnapshotAssignments(assignedGames);
    const shards = Array.from(
      { length: this.options.workers },
      (): IndexedPlayerPrivateAssignment[] => [],
    );
    immutableGames.forEach((game, index) => {
      shards[index % shards.length]?.push(game);
    });
    this.batchInFlight = true;
    try {
      const responses = await Promise.all(
        shards.flatMap((games, workerId) =>
          games.length === 0
            ? []
            : [this.executeShard(workerId, games)]
        ),
      );
      const indexed = responses
        .flat()
        .sort((left, right) => left.gameIndex - right.gameIndex);
      const expectedIndexes = [...immutableGames]
        .map(({ gameIndex }) => gameIndex)
        .sort((left, right) => left - right);
      if (
        indexed.length !== expectedIndexes.length
        || indexed.some(
          (result, index) => result.gameIndex !== expectedIndexes[index],
        )
      ) {
        throw new Error(
          "Player-private worker pool returned duplicate or missing indexes.",
        );
      }
      return Object.freeze(indexed);
    } finally {
      this.batchInFlight = false;
    }
  }

  public diagnostics(): PlayerPrivateWorkerPoolDiagnostics {
    return Object.freeze({
      configuredWorkers: this.options.workers,
      launches: this.launchCount,
      activeWorkers: this.activeWorkerCount,
      peakActiveWorkers: this.peakActiveWorkerCount,
      completedTasks: this.completedTaskCount,
      retriedTasks: this.retriedTaskCount,
    });
  }

  public async close(): Promise<void> {
    if (this.closed && this.liveSlots.size === 0) {
      return;
    }
    this.closed = true;
    const slots = [...this.liveSlots];
    await Promise.allSettled(
      slots.map((slot) =>
        slot.closeGracefully(this.options.shutdownTimeoutMs)
      ),
    );
    await Promise.allSettled(
      [...this.liveSlots].map((slot) => slot.terminateNow()),
    );
    this.slots.fill(undefined);
  }

  private async executeShard(
    workerId: number,
    assignedGames: readonly IndexedPlayerPrivateAssignment[],
  ): Promise<readonly IndexedPlayerPrivateResult[]> {
    const taskId = this.nextTaskId;
    this.nextTaskId += 1;
    return retryParallelWorkerOperation(
      async (attempt) => {
        if (attempt > 1) {
          this.retriedTaskCount += 1;
        }
        const slot = await this.usableSlot(workerId);
        const task = freezeRecursively({
          schemaVersion: 2,
          kind: "player-private-worker-task",
          ...slot.identity,
          taskId,
          attempt,
          assignedGames,
        } satisfies PlayerPrivateWorkerTask);
        try {
          const response = await slot.runTask(
            task,
            assignedGames,
            this.options.policy,
            this.options.maxPlies,
          );
          this.completedTaskCount += 1;
          return response.games;
        } catch (error: unknown) {
          if (isTransientParallelWorkerError(error)) {
            await slot.terminateNow();
            if (this.slots[workerId] === slot) {
              this.slots[workerId] = undefined;
            }
          }
          throw error;
        }
      },
      this.options.attempts,
    );
  }

  private async usableSlot(
    workerId: number,
  ): Promise<PlayerPrivateWorkerSlot> {
    const existing = this.slots[workerId];
    if (existing !== undefined && existing.usable) {
      return existing;
    }
    const replacement = await this.startSlotOnce(workerId);
    this.slots[workerId] = replacement;
    return replacement;
  }

  private startSlotWithRetries(
    workerId: number,
  ): Promise<PlayerPrivateWorkerSlot> {
    return retryParallelWorkerOperation(
      () => this.startSlotOnce(workerId),
      this.options.attempts,
    );
  }

  private async startSlotOnce(
    workerId: number,
  ): Promise<PlayerPrivateWorkerSlot> {
    if (this.closed) {
      throw new Error("Player-private worker pool is closed.");
    }
    const generation = this.generations[workerId];
    if (generation === undefined) {
      throw new RangeError("Player-private worker id is outside the pool.");
    }
    this.generations[workerId] = generation + 1;
    const identity = freezeRecursively({
      poolId: this.poolId,
      workerId,
      generation,
      authenticationToken: `auth-${randomUUID()}-${randomUUID()}`,
    } satisfies PlayerPrivateWorkerIdentity);
    const initialization = freezeRecursively({
      schemaVersion: 2,
      kind: "player-private-worker-initialize",
      ...identity,
      policy: this.options.policy,
      ...(this.options.maxPlies === undefined
        ? {}
        : { maxPlies: this.options.maxPlies }),
    } satisfies PlayerPrivateWorkerInitialization);
    this.launchCount += 1;
    const transport = this.options.workerFactory({
      entry: workerEntry(),
      workerData: initialization,
      execArgv: import.meta.url.endsWith(".ts")
        ? ["--import", sourceLoader()]
        : [],
    });
    this.activeWorkerCount += 1;
    this.peakActiveWorkerCount = Math.max(
      this.peakActiveWorkerCount,
      this.activeWorkerCount,
    );
    const slot = new PlayerPrivateWorkerSlot(
      identity,
      transport,
      this.options.initializationTimeoutMs,
      () => {
        if (this.liveSlots.delete(slot)) {
          this.activeWorkerCount -= 1;
        }
      },
    );
    this.liveSlots.add(slot);
    try {
      await slot.initialize();
      return slot;
    } catch (error: unknown) {
      await slot.terminateNow();
      throw error;
    }
  }
}

function validateAndSnapshotAssignments(
  assignedGames: readonly IndexedPlayerPrivateAssignment[],
): readonly IndexedPlayerPrivateAssignment[] {
  if (assignedGames.length === 0) {
    throw new RangeError(
      "Player-private worker pool batches must not be empty.",
    );
  }
  const indexes = new Set<number>();
  const seeds = new Set<number>();
  for (const { gameIndex, assignment } of assignedGames) {
    if (
      !Number.isSafeInteger(gameIndex)
      || gameIndex < 0
      || indexes.has(gameIndex)
    ) {
      throw new RangeError(
        "Player-private pool game indexes must be unique non-negative integers.",
      );
    }
    indexes.add(gameIndex);
    assertPlayerPrivateGameAssignment(assignment);
    if (seeds.has(assignment.seed)) {
      throw new RangeError(
        "Player-private assignment seeds must be unique.",
      );
    }
    seeds.add(assignment.seed);
  }
  return freezeRecursively(
    structuredClone([...assignedGames]),
  );
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
