import { randomUUID } from "node:crypto";
import {
  createOwnedNodeUciLeafEvaluator,
  NodeUciLeafEvaluatorCloseError,
  type OwnedNodeUciLeafEvaluator,
  throwAfterSameOwnerCleanup,
} from "@drawbackengine/chess-evaluator";
import {
  assertPlayerPrivateGameAssignment,
  assertPlayerPrivateSearchPolicy,
  assertPositiveSafeInteger,
  type IndexedPlayerPrivateAssignment,
  type IndexedPlayerPrivateResult,
  type PlayerPrivateSearchPolicy,
  type PlayerPrivateWorkerSearchPolicy,
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
  PlayerPrivateWorkerShutdownError,
  PlayerPrivateWorkerSlot,
} from "./player-private-worker-slot.js";

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface PlayerPrivateWorkerPoolOptions {
  readonly workers: number;
  readonly policy: PlayerPrivateSearchPolicy;
  readonly maxPlies?: number;
  /** Cancels evaluator and worker initialization through same-owner cleanup. */
  readonly signal?: AbortSignal;
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

/**
 * Bounded shutdown could not prove that every worker stopped. The retained
 * cleanup handle retries the same owned slots; it never launches replacements.
 */
export class PlayerPrivateWorkerPoolCleanupError extends AggregateError {
  public constructor(
    failures: readonly unknown[],
    message: string,
    private readonly retryOwnedCleanup: () => Promise<void>,
    private readonly readDiagnostics: () => PlayerPrivateWorkerPoolDiagnostics,
    private readonly retainedCleanupIdentity: object = Object.freeze({}),
  ) {
    super(failures, message);
    this.name = "PlayerPrivateWorkerPoolCleanupError";
  }

  public retryCleanup(): Promise<void> {
    return this.retryOwnedCleanup();
  }

  public diagnostics(): PlayerPrivateWorkerPoolDiagnostics {
    return this.readDiagnostics();
  }

  public cleanupOwnerIdentity(): object {
    return this.retainedCleanupIdentity;
  }
}

/** Pool initialization failed and its retained slots still need cleanup. */
export class PlayerPrivateWorkerPoolCreationError
extends PlayerPrivateWorkerPoolCleanupError {
  public constructor(
    initializationFailure: unknown,
    cleanupFailure: unknown,
    retryOwnedCleanup: () => Promise<void>,
    readDiagnostics: () => PlayerPrivateWorkerPoolDiagnostics,
  ) {
    super(
      [
        initializationFailure,
        ...(cleanupFailure instanceof PlayerPrivateWorkerPoolCleanupError
          ? cleanupFailure.errors as readonly unknown[]
          : [cleanupFailure]),
      ],
      "Player-private worker pool initialization failed and cleanup was incomplete.",
      retryOwnedCleanup,
      readDiagnostics,
      cleanupFailure instanceof PlayerPrivateWorkerPoolCleanupError
        ? cleanupFailure.cleanupOwnerIdentity()
        : Object.freeze({}),
    );
    this.name = "PlayerPrivateWorkerPoolCreationError";
  }
}

export async function createPlayerPrivateWorkerPool(
  options: PlayerPrivateWorkerPoolOptions,
): Promise<PlayerPrivateWorkerPool> {
  throwIfAborted(options.signal);
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
    ...(options.signal === undefined ? {} : { signal: options.signal }),
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
    try {
      await pool.close();
    } catch (cleanupFailure: unknown) {
      if (pool.diagnostics().activeWorkers === 0) {
        throw new AggregateError(
          [error, cleanupFailure],
          "Player-private worker pool initialization and completed cleanup both reported failures.",
        );
      }
      throw new PlayerPrivateWorkerPoolCreationError(
        error,
        cleanupFailure,
        () => pool.close(),
        () => pool.diagnostics(),
      );
    }
    throw error;
  }
}

interface ValidatedPoolOptions {
  readonly workers: number;
  readonly policy: PlayerPrivateSearchPolicy;
  readonly maxPlies?: number;
  readonly signal?: AbortSignal;
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
  private readonly retainedCleanupIdentity = Object.freeze({});
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
    throwIfAborted(this.options.signal);
    const starts = this.slots.map((_, workerId) =>
      this.startSlotWithRetries(workerId)
    );
    const settled = await Promise.allSettled(starts);
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : []
    );
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            "Multiple player-private worker slots failed initialization.",
          );
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
      const settled = await Promise.allSettled(
        shards.flatMap((games, workerId) =>
          games.length === 0
            ? []
            : [this.executeShard(workerId, games)]
        ),
      );
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : []
      );
      if (failures.length > 0) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(
              failures,
              "Multiple player-private worker shards failed.",
            );
      }
      const responses = settled.map((result) => {
        if (result.status !== "fulfilled") {
          throw new Error("Player-private worker shard settlement was lost.");
        }
        return result.value;
      });
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
    const graceful = await Promise.allSettled(
      slots.map((slot) =>
        slot.closeGracefully(this.options.shutdownTimeoutMs)
      ),
    );
    const shutdownFailures: unknown[] = [];
    const retryableGracefulFailures = new Map<
      PlayerPrivateWorkerSlot,
      unknown
    >();
    graceful.forEach((result, index) => {
      if (result.status !== "rejected") {
        return;
      }
      const slot = slots[index];
      if (
        result.reason instanceof PlayerPrivateWorkerShutdownError
        || (slot !== undefined && !this.liveSlots.has(slot))
      ) {
        shutdownFailures.push(result.reason);
      } else if (slot !== undefined) {
        retryableGracefulFailures.set(slot, result.reason as unknown);
      }
    });
    const forceableSlots = [...this.liveSlots];
    const forced = await Promise.allSettled(
      forceableSlots.map((slot) => slot.terminateNow()),
    );
    this.slots.fill(undefined);
    const failures: unknown[] = [...shutdownFailures];
    forced.forEach((result, index) => {
      if (result.status === "rejected") {
        const slot = forceableSlots[index];
        const gracefulFailure = slot === undefined
          ? undefined
          : retryableGracefulFailures.get(slot);
        if (gracefulFailure !== undefined) {
          failures.push(gracefulFailure);
        }
        failures.push(result.reason as unknown);
      }
    });
    if (this.liveSlots.size > 0 && failures.length === 0) {
      failures.push(
        new Error("One or more player-private workers remain active."),
      );
    }
    if (failures.length > 0) {
      if (this.liveSlots.size === 0) {
        throw new AggregateError(
          failures,
          "Player-private worker pool cleanup completed abnormally.",
        );
      }
      throw new PlayerPrivateWorkerPoolCleanupError(
        failures,
        "Player-private worker pool cleanup failed.",
        () => this.close(),
        () => this.diagnostics(),
        this.retainedCleanupIdentity,
      );
    }
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
            try {
              await slot.closeGracefully(
                this.options.shutdownTimeoutMs,
              );
            } catch (cleanupFailure: unknown) {
              throw new AggregateError(
                [error, cleanupFailure],
                "Transient player-private task failure was not followed by authenticated worker cleanup.",
              );
            }
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
    throwIfAborted(this.options.signal);
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
      policy: workerSearchPolicy(this.options.policy),
      ...(this.options.maxPlies === undefined
        ? {}
        : { maxPlies: this.options.maxPlies }),
    } satisfies PlayerPrivateWorkerInitialization);
    const hostedEvaluator = await this.createHostedEvaluator();
    if (this.options.signal?.aborted === true) {
      const interrupted = abortReason(this.options.signal);
      if (hostedEvaluator === undefined) {
        throw interrupted;
      }
      return throwAfterSameOwnerCleanup(
        interrupted,
        () => hostedEvaluator.close(),
        "Startup cancellation and parent-owned UCI cleanup encountered failures.",
        leafEvaluatorCleanupProvesComplete,
      );
    }
    if (this.poolIsClosed()) {
      const closedDuringEvaluatorCreation = new Error(
        "Player-private worker pool closed during evaluator creation.",
      );
      if (hostedEvaluator === undefined) {
        throw closedDuringEvaluatorCreation;
      }
      return throwAfterSameOwnerCleanup(
        closedDuringEvaluatorCreation,
        () => hostedEvaluator.close(),
        "Pool closure raced evaluator creation and parent-owned UCI cleanup encountered failures.",
        leafEvaluatorCleanupProvesComplete,
      );
    }
    this.launchCount += 1;
    let transport: ReturnType<PlayerPrivateWorkerFactory>;
    try {
      transport = this.options.workerFactory({
        entry: workerEntry(),
        workerData: initialization,
        execArgv: import.meta.url.endsWith(".ts")
          ? ["--import", sourceLoader()]
          : [],
      });
    } catch (error: unknown) {
      if (hostedEvaluator === undefined) {
        throw error;
      }
      return throwAfterSameOwnerCleanup(
        error,
        () => hostedEvaluator.close(),
        "Worker launch failed and parent-owned UCI cleanup encountered failures.",
        leafEvaluatorCleanupProvesComplete,
      );
    }
    let slot: PlayerPrivateWorkerSlot | undefined;
    try {
      slot = new PlayerPrivateWorkerSlot(
        identity,
        transport,
        this.options.initializationTimeoutMs,
        evaluatorId(this.options.policy),
        () => {
          if (slot !== undefined && this.liveSlots.delete(slot)) {
            this.activeWorkerCount -= 1;
          }
        },
        hostedEvaluator,
      );
    } catch (error: unknown) {
      const cleanup = provisionalWorkerCleanup(transport, hostedEvaluator);
      return throwAfterSameOwnerCleanup(
        error,
        cleanup.close,
        "Worker slot construction failed and provisional resource cleanup encountered failures.",
        cleanup.provesComplete,
      );
    }
    this.activeWorkerCount += 1;
    this.peakActiveWorkerCount = Math.max(
      this.peakActiveWorkerCount,
      this.activeWorkerCount,
    );
    this.liveSlots.add(slot);
    try {
      await abortableOperation(slot.initialize(), this.options.signal);
      return slot;
    } catch (error: unknown) {
      try {
        await slot.terminateNow();
      } catch (cleanupFailure: unknown) {
        throw new AggregateError(
          [error, cleanupFailure],
          "Player-private worker initialization and cleanup both failed.",
        );
      }
      throw error;
    }
  }

  private async createHostedEvaluator(): Promise<
    OwnedNodeUciLeafEvaluator | undefined
  > {
    if (this.options.policy.evaluator.kind === "material") {
      return undefined;
    }
    const evaluator = await createOwnedNodeUciLeafEvaluator(
      this.options.policy.evaluator.config,
      {
        ...(this.options.signal === undefined
          ? {}
          : { signal: this.options.signal }),
      },
    );
    if (evaluator.id !== this.options.policy.evaluator.evaluatorId) {
      return throwAfterSameOwnerCleanup(
        new Error("Parent-owned UCI evaluator identity is invalid."),
        () => evaluator.close(),
        "UCI evaluator identity rejection and cleanup encountered failures.",
        leafEvaluatorCleanupProvesComplete,
      );
    }
    return evaluator;
  }

  private poolIsClosed(): boolean {
    return this.closed;
  }
}

function abortableOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return operation;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    void operation.then(
      (value) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error instanceof Error
            ? error
            : new Error("Player-private worker initialization failed.", {
                cause: error,
              }));
        }
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Player-private startup was aborted.", "AbortError");
}

function leafEvaluatorCleanupProvesComplete(error: unknown): boolean {
  return error instanceof NodeUciLeafEvaluatorCloseError
    && error.privateResourcesRemoved
    && error.processTerminated;
}

function provisionalWorkerCleanup(
  transport: ReturnType<PlayerPrivateWorkerFactory>,
  hostedEvaluator: OwnedNodeUciLeafEvaluator | undefined,
): {
  readonly close: () => Promise<void>;
  readonly provesComplete: () => boolean;
} {
  let transportTerminated = false;
  let evaluatorClosed = hostedEvaluator === undefined;
  const close = async (): Promise<void> => {
    const [transportResult, evaluatorResult] = await Promise.allSettled([
      transportTerminated
        ? Promise.resolve()
        : Promise.resolve().then(() => transport.terminate()),
      evaluatorClosed
        ? Promise.resolve()
        : Promise.resolve().then(() => hostedEvaluator?.close()),
    ]);
    const failures: unknown[] = [];
    if (transportResult.status === "fulfilled") {
      transportTerminated = true;
    } else {
      failures.push(transportResult.reason as unknown);
    }
    if (evaluatorResult.status === "fulfilled") {
      evaluatorClosed = true;
    } else {
      const evaluatorFailure = evaluatorResult.reason as unknown;
      evaluatorClosed = leafEvaluatorCleanupProvesComplete(evaluatorFailure);
      failures.push(evaluatorFailure);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Provisional player-private worker resource cleanup reported failures.",
      );
    }
  };
  return {
    close,
    provesComplete: () => transportTerminated && evaluatorClosed,
  };
}

function workerSearchPolicy(
  policy: PlayerPrivateSearchPolicy,
): PlayerPrivateWorkerSearchPolicy {
  return freezeRecursively({
    ...policy,
    evaluator: policy.evaluator.kind === "material"
      ? policy.evaluator
      : {
          kind: policy.evaluator.kind,
          version: policy.evaluator.version,
          evaluatorId: policy.evaluator.evaluatorId,
        },
  } satisfies PlayerPrivateWorkerSearchPolicy);
}

function evaluatorId(policy: PlayerPrivateSearchPolicy): string {
  return policy.evaluator.kind === "material"
    ? "drawback-material/v1"
    : policy.evaluator.evaluatorId;
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
  if (ArrayBuffer.isView(value)) {
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
