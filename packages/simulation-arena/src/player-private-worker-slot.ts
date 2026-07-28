import {
  protocolRecord,
  type IndexedPlayerPrivateAssignment,
  type PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";
import {
  assertPlayerPrivateWorkerReady,
  assertPlayerPrivateWorkerStopped,
  assertPlayerPrivateWorkerTaskFailure,
  type PlayerPrivateWorkerIdentity,
  type PlayerPrivateWorkerShutdown,
  type PlayerPrivateWorkerTask,
  type PlayerPrivateWorkerTaskResult,
} from "./player-private-worker-protocol.js";
import {
  assertPlayerPrivateWorkerTaskResult,
} from "./player-private-result-validation.js";
import {
  TransientParallelWorkerError,
} from "./worker-retry.js";
import type {
  PlayerPrivateWorkerTransport,
} from "./player-private-worker-transport.js";

type WorkerSlotState =
  | "initializing"
  | "idle"
  | "busy"
  | "closing"
  | "closed";

interface PendingTask {
  readonly task: PlayerPrivateWorkerTask;
  readonly assignedGames: readonly IndexedPlayerPrivateAssignment[];
  readonly policy: PlayerPrivateSearchPolicy;
  readonly maxPlies?: number;
  readonly deferred: Deferred<PlayerPrivateWorkerTaskResult>;
}

export class PlayerPrivateWorkerSlot {
  private state: WorkerSlotState = "initializing";
  private readonly ready = deferred<undefined>();
  private readonly stopped = deferred<undefined>();
  private readonly unsubscribe: () => void;
  private initializationTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingTask: PendingTask | undefined;
  private terminalError: Error | undefined;
  private termination: Promise<void> | undefined;
  private closedNotified = false;

  public constructor(
    public readonly identity: PlayerPrivateWorkerIdentity,
    private readonly transport: PlayerPrivateWorkerTransport,
    initializationTimeoutMs: number,
    private readonly onClosed: () => void,
  ) {
    this.unsubscribe = transport.subscribe({
      message: (value) => {
        this.handleMessage(value);
      },
      error: (error) => {
        this.handleProcessFailure(
          new TransientParallelWorkerError(
            "worker-process-error",
            `Player-private worker ${String(identity.workerId)} failed: `
              + error.message,
            { cause: error },
          ),
        );
      },
      exit: (code) => {
        if (this.state === "closing" || this.state === "closed") {
          this.stopped.resolve(undefined);
          this.finalizeClosed();
          return;
        }
        this.handleProcessFailure(
          new TransientParallelWorkerError(
            "worker-process-exit",
            `Player-private worker ${String(identity.workerId)} `
              + `exited unexpectedly with code ${String(code)}.`,
          ),
        );
      },
    });
    this.initializationTimer = setTimeout(() => {
      this.handleProcessFailure(
        new TransientParallelWorkerError(
          "worker-initialization-timeout",
          `Player-private worker ${String(identity.workerId)} `
            + "did not authenticate readiness in time.",
        ),
      );
    }, initializationTimeoutMs);
  }

  public get usable(): boolean {
    return this.state === "idle";
  }

  public initialize(): Promise<void> {
    return this.ready.promise;
  }

  public runTask(
    task: PlayerPrivateWorkerTask,
    assignedGames: readonly IndexedPlayerPrivateAssignment[],
    policy: PlayerPrivateSearchPolicy,
    maxPlies?: number,
  ): Promise<PlayerPrivateWorkerTaskResult> {
    if (this.state !== "idle") {
      throw this.terminalError
        ?? new Error("Player-private worker is not ready for a task.");
    }
    const taskDeferred = deferred<PlayerPrivateWorkerTaskResult>();
    this.pendingTask = {
      task,
      assignedGames,
      policy,
      ...(maxPlies === undefined ? {} : { maxPlies }),
      deferred: taskDeferred,
    };
    this.state = "busy";
    try {
      this.transport.postMessage(task);
    } catch (error: unknown) {
      this.handleProcessFailure(
        new TransientParallelWorkerError(
          "worker-post-message",
          "Player-private worker task dispatch failed.",
          { cause: error },
        ),
      );
    }
    return taskDeferred.promise;
  }

  public async closeGracefully(timeoutMs: number): Promise<void> {
    if (this.state === "closed") {
      await this.termination;
      return;
    }
    if (this.state !== "idle") {
      await this.terminateNow();
      return;
    }
    this.state = "closing";
    const request = freezeRecursively({
      schemaVersion: 2,
      kind: "player-private-worker-shutdown",
      ...this.identity,
    } satisfies PlayerPrivateWorkerShutdown);
    try {
      this.transport.postMessage(request);
      await waitForSignal(this.stopped.promise, timeoutMs);
    } catch {
      // Termination below is the authoritative cleanup path.
    }
    await this.terminateNow();
  }

  public terminateNow(): Promise<void> {
    if (this.termination !== undefined) {
      return this.termination;
    }
    this.clearInitializationTimer();
    if (this.state === "initializing") {
      this.ready.reject(
        this.terminalError
          ?? new Error("Player-private worker initialization was cancelled."),
      );
    }
    if (this.pendingTask !== undefined) {
      this.pendingTask.deferred.reject(
        this.terminalError
          ?? new Error("Player-private worker task was cancelled."),
      );
      this.pendingTask = undefined;
    }
    this.state = "closing";
    this.termination = (async (): Promise<void> => {
      try {
        await this.transport.terminate();
      } catch {
        // The transport may already be gone; finalization is still required.
      } finally {
        this.finalizeClosed();
      }
    })();
    return this.termination;
  }

  private handleMessage(value: unknown): void {
    if (this.state === "initializing") {
      try {
        assertPlayerPrivateWorkerReady(value, this.identity);
        this.clearInitializationTimer();
        this.state = "idle";
        this.ready.resolve(undefined);
      } catch (error: unknown) {
        this.handlePermanentProtocolFailure(
          "Player-private worker returned an invalid ready response.",
          error,
        );
      }
      return;
    }
    if (this.state === "busy") {
      this.handleTaskMessage(value);
      return;
    }
    if (this.state === "closing") {
      try {
        assertPlayerPrivateWorkerStopped(value, this.identity);
        this.stopped.resolve(undefined);
      } catch (error: unknown) {
        this.handlePermanentProtocolFailure(
          "Player-private worker returned an invalid shutdown response.",
          error,
        );
      }
      return;
    }
    if (this.state === "idle") {
      this.handlePermanentProtocolFailure(
        "Player-private worker sent an unsolicited message.",
      );
    }
  }

  private handleTaskMessage(value: unknown): void {
    const pending = this.pendingTask;
    if (pending === undefined) {
      this.handlePermanentProtocolFailure(
        "Player-private worker lost its active task.",
      );
      return;
    }
    try {
      const record = protocolRecord(
        value,
        "player-private worker task response",
      );
      if (record["kind"] === "player-private-worker-task-failure") {
        assertPlayerPrivateWorkerTaskFailure(
          value,
          this.identity,
          pending.task.taskId,
          pending.task.attempt,
        );
        this.pendingTask = undefined;
        this.state = "idle";
        const failure = value.failure;
        pending.deferred.reject(
          failure.transient
            ? new TransientParallelWorkerError(
                "worker-reported-transient",
                failure.message,
              )
            : new Error(failure.message),
        );
        return;
      }
      assertPlayerPrivateWorkerTaskResult(
        value,
        this.identity,
        pending.task.taskId,
        pending.task.attempt,
        pending.assignedGames,
        pending.policy,
        pending.maxPlies,
      );
      this.pendingTask = undefined;
      this.state = "idle";
      pending.deferred.resolve(value);
    } catch (error: unknown) {
      this.handlePermanentProtocolFailure(
        "Player-private worker returned an invalid task response.",
        error,
      );
    }
  }

  private handlePermanentProtocolFailure(
    message: string,
    cause?: unknown,
  ): void {
    const error = new TypeError(message, { cause });
    this.terminalError = error;
    this.clearInitializationTimer();
    if (this.state === "initializing") {
      this.ready.reject(error);
    }
    if (this.pendingTask !== undefined) {
      this.pendingTask.deferred.reject(error);
      this.pendingTask = undefined;
    }
    this.state = "closing";
    void this.terminateNow();
  }

  private handleProcessFailure(error: TransientParallelWorkerError): void {
    if (this.state === "closed" || this.state === "closing") {
      return;
    }
    this.terminalError = error;
    this.clearInitializationTimer();
    if (this.state === "initializing") {
      this.ready.reject(error);
    }
    if (this.pendingTask !== undefined) {
      this.pendingTask.deferred.reject(error);
      this.pendingTask = undefined;
    }
    this.state = "closing";
    void this.terminateNow();
  }

  private clearInitializationTimer(): void {
    if (this.initializationTimer !== undefined) {
      clearTimeout(this.initializationTimer);
      this.initializationTimer = undefined;
    }
  }

  private finalizeClosed(): void {
    this.clearInitializationTimer();
    this.state = "closed";
    this.stopped.resolve(undefined);
    if (!this.closedNotified) {
      this.closedNotified = true;
      this.unsubscribe();
      this.onClosed();
    }
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] | undefined;
  let reject: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (resolve === undefined || reject === undefined) {
    throw new Error("Failed to initialize a worker lifecycle promise.");
  }
  return { promise, resolve, reject };
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

async function waitForSignal(
  signal: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([signal, timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}
