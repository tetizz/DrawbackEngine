import {
  NodeUciLeafEvaluatorCloseError,
  UciTimeoutError,
  UciTransportError,
} from "@drawbackengine/chess-evaluator";
import {
  UnsupportedDrawbackLeafPositionError,
  type DrawbackLeafEvaluator,
} from "@drawbackengine/drawback-search";
import {
  protocolRecord,
  type IndexedPlayerPrivateAssignment,
  type PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";
import {
  assertPlayerPrivateWorkerInitializationFailure,
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
import {
  assertPlayerPrivateWorkerEvaluationCancel,
  assertPlayerPrivateWorkerEvaluationRequest,
  isPlayerPrivateWorkerEvaluationChildKind,
  restorePlayerPrivateUciLeafPosition,
  type PlayerPrivateWorkerEvaluationFailure,
  type PlayerPrivateWorkerEvaluationResult,
} from "./player-private-leaf-evaluator-protocol.js";

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

export interface PlayerPrivateWorkerHostedEvaluator
extends DrawbackLeafEvaluator {
  close(): Promise<void>;
}

interface HostedEvaluation {
  readonly taskId: number;
  readonly attempt: number;
  readonly controller: AbortController;
}

export class PlayerPrivateWorkerShutdownError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlayerPrivateWorkerShutdownError";
  }
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
  private shutdownRequested = false;
  private gracefulStopAcknowledged = false;
  private forceTerminationStarted = false;
  private closedNotified = false;
  private readonly hostedEvaluations = new Map<number, HostedEvaluation>();
  private hostedEvaluatorClose: Promise<void> | undefined;
  private hostedEvaluatorFailureObserved = false;

  public constructor(
    public readonly identity: PlayerPrivateWorkerIdentity,
    private readonly transport: PlayerPrivateWorkerTransport,
    initializationTimeoutMs: number,
    private readonly expectedEvaluatorId: string,
    private readonly onClosed: () => void,
    private readonly hostedEvaluator?: PlayerPrivateWorkerHostedEvaluator,
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
          if (
            this.state !== "closed"
            && this.shutdownRequested
            && !this.forceTerminationStarted
            && (!this.gracefulStopAcknowledged || code !== 0)
          ) {
            const failure = new PlayerPrivateWorkerShutdownError(
              "Player-private worker exited before authenticating a clean shutdown.",
              {
                cause: new Error(
                  `Worker exit code was ${String(code)}.`,
                ),
              },
            );
            this.terminalError = failure;
            this.stopped.reject(failure);
          } else {
            this.stopped.resolve(undefined);
          }
          if (this.termination === undefined) {
            this.beginForcedTermination();
          }
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
    if (this.state === "initializing") {
      await this.terminateNow();
      return;
    }
    if (!this.shutdownRequested) {
      this.shutdownRequested = true;
      this.abortHostedEvaluations();
      if (this.pendingTask !== undefined) {
        this.pendingTask.deferred.reject(
          new Error("Player-private worker task was cancelled by shutdown."),
        );
      }
      this.state = "closing";
      const request = freezeRecursively({
        schemaVersion: 2,
        kind: "player-private-worker-shutdown",
        ...this.identity,
      } satisfies PlayerPrivateWorkerShutdown);
      try {
        this.transport.postMessage(request);
      } catch (error: unknown) {
        throw new PlayerPrivateWorkerShutdownError(
          "Player-private worker shutdown dispatch failed.",
          { cause: error },
        );
      }
    }
    try {
      await waitForSignal(this.stopped.promise, timeoutMs);
    } catch (error: unknown) {
      if (error instanceof PlayerPrivateWorkerShutdownError) {
        throw error;
      }
      throw new PlayerPrivateWorkerShutdownError(
        "Player-private worker did not authenticate shutdown before the deadline.",
        { cause: error },
      );
    }
    await this.terminateNow();
    if (this.terminalError instanceof PlayerPrivateWorkerShutdownError) {
      throw this.terminalError;
    }
  }

  public terminateNow(): Promise<void> {
    if (this.termination !== undefined) {
      return this.termination;
    }
    if (this.state === "closed") {
      return Promise.resolve();
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
    this.forceTerminationStarted = true;
    this.abortHostedEvaluations();
    const attempt = Promise.allSettled([
      Promise.resolve().then(() => this.transport.terminate()),
      this.closeHostedEvaluator(),
    ]).then((results) => {
      const failures: unknown[] = [];
      const workerResult = results[0];
      const evaluatorResult = results[1];
      const evaluatorFailure = evaluatorResult.status === "rejected"
        ? evaluatorResult.reason as unknown
        : undefined;
      const evaluatorCleanupAccepted =
        evaluatorResult.status === "fulfilled"
        || this.acceptedPostFailureCleanup(evaluatorFailure);
      const cleanupComplete =
        workerResult.status === "fulfilled"
        && (
          evaluatorCleanupAccepted
          || this.completedHostedEvaluatorCleanup(evaluatorFailure)
        );
      if (workerResult.status === "rejected") {
        failures.push(workerResult.reason as unknown);
      }
      if (
        evaluatorResult.status === "rejected"
        && !evaluatorCleanupAccepted
      ) {
        failures.push(evaluatorFailure);
      }
      if (failures.length > 0) {
        const error = new AggregateError(
          failures,
          "Player-private worker or parent-owned evaluator termination failed.",
        );
        this.terminalError = error;
        if (cleanupComplete) {
          this.finalizeClosed();
        }
        throw error;
      }
      this.finalizeClosed();
    }).catch((error: unknown) => {
      this.termination = undefined;
      this.forceTerminationStarted = false;
      throw error;
    });
    this.termination = attempt;
    return attempt;
  }

  private handleMessage(value: unknown): void {
    try {
      const record = protocolRecord(
        value,
        "player-private worker response",
      );
      if (isPlayerPrivateWorkerEvaluationChildKind(record["kind"])) {
        this.handleHostedEvaluationMessage(value, record["kind"]);
        return;
      }
    } catch (error: unknown) {
      this.handlePermanentProtocolFailure(
        "Player-private worker sent an invalid evaluator request.",
        error,
      );
      return;
    }
    if (this.state === "initializing") {
      try {
        const record = protocolRecord(
          value,
          "player-private worker initialization response",
        );
        if (
          record["kind"]
          === "player-private-worker-initialization-failure"
        ) {
          assertPlayerPrivateWorkerInitializationFailure(
            value,
            this.identity,
          );
          const failure = value.failure;
          if (failure.transient) {
            this.handleProcessFailure(
              new TransientParallelWorkerError(
                "worker-reported-transient",
                failure.message,
              ),
            );
          } else {
            this.handlePermanentProtocolFailure(
              "Player-private worker evaluator initialization failed.",
              new Error(failure.message),
            );
          }
          return;
        }
        assertPlayerPrivateWorkerReady(
          value,
          this.identity,
          this.expectedEvaluatorId,
        );
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
        const record = protocolRecord(
          value,
          "player-private worker shutdown response",
        );
        if (record["kind"] === "player-private-worker-stopped") {
          assertPlayerPrivateWorkerStopped(value, this.identity);
          this.gracefulStopAcknowledged = true;
          this.pendingTask = undefined;
          this.stopped.resolve(undefined);
          return;
        }
        const pending = this.pendingTask;
        if (pending === undefined) {
          throw new TypeError(
            "Player-private worker sent an unexpected shutdown response.",
          );
        }
        if (record["kind"] === "player-private-worker-task-failure") {
          assertPlayerPrivateWorkerTaskFailure(
            value,
            this.identity,
            pending.task.taskId,
            pending.task.attempt,
          );
        } else {
          assertPlayerPrivateWorkerTaskResult(
            value,
            this.identity,
            pending.task.taskId,
            pending.task.attempt,
            pending.assignedGames,
            pending.policy,
            pending.maxPlies,
          );
        }
        this.pendingTask = undefined;
      } catch (error: unknown) {
        this.handleShutdownProtocolFailure(
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
        this.abortHostedEvaluations();
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
      this.abortHostedEvaluations();
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
    this.abortHostedEvaluations();
    this.beginForcedTermination();
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
    this.abortHostedEvaluations();
    this.beginForcedTermination();
  }

  private handleShutdownProtocolFailure(
    message: string,
    cause?: unknown,
  ): void {
    const error = new PlayerPrivateWorkerShutdownError(
      message,
      { cause },
    );
    this.terminalError = error;
    this.clearInitializationTimer();
    if (this.pendingTask !== undefined) {
      this.pendingTask.deferred.reject(error);
      this.pendingTask = undefined;
    }
    this.state = "closing";
    this.abortHostedEvaluations();
    this.stopped.reject(error);
  }

  private handleHostedEvaluationMessage(
    value: unknown,
    kind: unknown,
  ): void {
    const pending = this.pendingTask;
    if (kind === "player-private-worker-evaluation-cancel") {
      if (
        this.hostedEvaluator === undefined
        || (this.state !== "busy" && this.state !== "closing")
      ) {
        throw new TypeError(
          "Worker evaluator cancellation requires an active parent-owned UCI task.",
        );
      }
      const cancellation = protocolRecord(
        value,
        "worker evaluation cancellation",
      );
      const evaluationId = cancellation["evaluationId"];
      if (
        !Number.isSafeInteger(evaluationId)
        || (evaluationId as number) < 0
      ) {
        throw new TypeError("Worker evaluator cancellation ID is invalid.");
      }
      const active = this.hostedEvaluations.get(evaluationId as number);
      const taskId = pending?.task.taskId ?? active?.taskId;
      const attempt = pending?.task.attempt ?? active?.attempt;
      if (taskId === undefined || attempt === undefined) {
        throw new TypeError(
          "Worker evaluator cancellation lost its task correlation.",
        );
      }
      assertPlayerPrivateWorkerEvaluationCancel(
        value,
        this.identity,
        taskId,
        attempt,
      );
      active?.controller.abort();
      return;
    }
    if (
      this.state !== "busy"
      || pending === undefined
      || this.hostedEvaluator === undefined
    ) {
      throw new TypeError(
        "Worker evaluator requests require an active parent-owned UCI task.",
      );
    }
    assertPlayerPrivateWorkerEvaluationRequest(
      value,
      this.identity,
      pending.task.taskId,
      pending.task.attempt,
    );
    if (
      this.hostedEvaluations.size > 0
      || this.hostedEvaluations.has(value.evaluationId)
    ) {
      throw new TypeError("Worker requested concurrent UCI evaluations.");
    }
    const controller = new AbortController();
    this.hostedEvaluations.set(value.evaluationId, {
      taskId: value.taskId,
      attempt: value.attempt,
      controller,
    });
    const position = restorePlayerPrivateUciLeafPosition(value.position);
    void this.hostedEvaluator.evaluate(position, controller.signal).then(
      (score) => {
        this.finishHostedEvaluation(value.evaluationId, {
          schemaVersion: 2,
          kind: "player-private-worker-evaluation-result",
          ...this.identity,
          taskId: value.taskId,
          attempt: value.attempt,
          evaluationId: value.evaluationId,
          score,
        });
      },
      (error: unknown) => {
        const failure = hostedEvaluationFailure(error);
        this.hostedEvaluatorFailureObserved ||=
          failure.code === "transient-evaluator";
        this.finishHostedEvaluation(value.evaluationId, {
          schemaVersion: 2,
          kind: "player-private-worker-evaluation-failure",
          ...this.identity,
          taskId: value.taskId,
          attempt: value.attempt,
          evaluationId: value.evaluationId,
          failure,
        });
      },
    );
  }

  private finishHostedEvaluation(
    evaluationId: number,
    response:
      | PlayerPrivateWorkerEvaluationResult
      | PlayerPrivateWorkerEvaluationFailure,
  ): void {
    if (!this.hostedEvaluations.delete(evaluationId)) {
      return;
    }
    if (this.state !== "busy") {
      return;
    }
    try {
      this.transport.postMessage(Object.freeze(response));
    } catch (error: unknown) {
      this.handleProcessFailure(new TransientParallelWorkerError(
        "worker-post-message",
        "Parent-owned UCI evaluation response dispatch failed.",
        { cause: error },
      ));
    }
  }

  private abortHostedEvaluations(): void {
    for (const active of this.hostedEvaluations.values()) {
      active.controller.abort();
    }
  }

  private closeHostedEvaluator(): Promise<void> {
    if (this.hostedEvaluatorClose !== undefined) {
      return this.hostedEvaluatorClose;
    }
    this.abortHostedEvaluations();
    const attempt = Promise.resolve().then(async () => {
      await this.hostedEvaluator?.close();
    });
    this.hostedEvaluatorClose = attempt;
    void attempt.then(
      () => undefined,
      (error: unknown) => {
        if (
          this.hostedEvaluatorClose === attempt
          && (
            !(error instanceof NodeUciLeafEvaluatorCloseError)
            || !error.privateResourcesRemoved
            || !error.processTerminated
          )
        ) {
          this.hostedEvaluatorClose = undefined;
        }
      },
    );
    return attempt;
  }

  private beginForcedTermination(): void {
    void this.terminateNow().catch(() => {
      // The slot retains the typed terminal error. Pool cleanup retries the
      // bounded termination instead of leaking a detached rejection.
    });
  }

  private acceptedPostFailureCleanup(error: unknown): boolean {
    return this.hostedEvaluatorFailureObserved
      && error instanceof NodeUciLeafEvaluatorCloseError
      && error.privateResourcesRemoved
      && error.processTerminated;
  }

  private completedHostedEvaluatorCleanup(error: unknown): boolean {
    return error instanceof NodeUciLeafEvaluatorCloseError
      && error.privateResourcesRemoved
      && error.processTerminated;
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
    if (
      !this.shutdownRequested
      || this.gracefulStopAcknowledged
      || this.forceTerminationStarted
    ) {
      this.stopped.resolve(undefined);
    }
    if (!this.closedNotified) {
      this.closedNotified = true;
      this.unsubscribe();
      this.onClosed();
    }
  }
}

function hostedEvaluationFailure(
  error: unknown,
): PlayerPrivateWorkerEvaluationFailure["failure"] {
  if (isAbortError(error)) {
    return Object.freeze({
      code: "evaluation-aborted",
      message: "Parent-owned UCI leaf evaluation was aborted.",
    });
  }
  if (error instanceof UnsupportedDrawbackLeafPositionError) {
    return Object.freeze({
      code: "unsupported-position",
      message: "The configured UCI evaluator cannot represent this public leaf.",
    });
  }
  if (containsTransientUciFailure(error)) {
    return Object.freeze({
      code: "transient-evaluator",
      message: "The parent-owned UCI evaluator became unavailable.",
    });
  }
  return Object.freeze({
    code: "evaluation-failed",
    message: "The parent-owned UCI leaf evaluation failed.",
  });
}

function containsTransientUciFailure(value: unknown): boolean {
  const seen = new Set<unknown>();
  let current = value;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof UciTimeoutError || current instanceof UciTransportError) {
      return true;
    }
    seen.add(current);
    current = current.cause;
  }
  return false;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
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
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Worker shutdown deadline elapsed."));
    }, timeoutMs);
  });
  try {
    await Promise.race([signal, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
