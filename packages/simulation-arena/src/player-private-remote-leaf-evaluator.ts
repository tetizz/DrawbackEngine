import {
  UciTransportError,
} from "@drawbackengine/chess-evaluator";
import {
  UnsupportedDrawbackLeafPositionError,
  type DrawbackLeafEvaluator,
  type LeafPosition,
} from "@drawbackengine/drawback-search";
import {
  assertPlayerPrivateWorkerEvaluationFailure,
  assertPlayerPrivateWorkerEvaluationResult,
  isPlayerPrivateWorkerEvaluationParentKind,
  snapshotPlayerPrivateUciLeafPosition,
  type PlayerPrivateWorkerEvaluationCancel,
  type PlayerPrivateWorkerEvaluationRequest,
} from "./player-private-leaf-evaluator-protocol.js";
import {
  protocolRecord,
} from "./player-private-parallel-protocol.js";
import type {
  PlayerPrivateWorkerIdentity,
  PlayerPrivateWorkerTask,
} from "./player-private-worker-protocol.js";

interface EvaluationPort {
  postMessage(value: unknown): void;
}

interface TaskCorrelation {
  readonly taskId: number;
  readonly attempt: number;
}

interface PendingEvaluation extends TaskCorrelation {
  readonly resolve: (score: number) => void;
  readonly reject: (reason: Error) => void;
  readonly removeAbortListener: () => void;
}

type IgnoredEvaluation = TaskCorrelation;

/**
 * Worker-side evaluator proxy. UCI processes and private staged artifacts stay
 * owned by the parent process, so terminating this worker cannot orphan them.
 */
export class PlayerPrivateRemoteLeafEvaluator
implements DrawbackLeafEvaluator {
  private nextEvaluationId = 0;
  private activeTask: TaskCorrelation | undefined;
  private readonly pending = new Map<number, PendingEvaluation>();
  private readonly ignored = new Map<number, IgnoredEvaluation>();
  private closed = false;

  public constructor(
    public readonly id: string,
    private readonly identity: PlayerPrivateWorkerIdentity,
    private readonly port: EvaluationPort,
  ) {}

  public beginTask(task: PlayerPrivateWorkerTask): void {
    if (this.closed) {
      throw new Error("Remote UCI leaf evaluator is closed.");
    }
    if (this.activeTask !== undefined || this.pending.size > 0) {
      throw new Error("Remote UCI leaf evaluator already has an active task.");
    }
    this.activeTask = {
      taskId: task.taskId,
      attempt: task.attempt,
    };
  }

  public endTask(task: PlayerPrivateWorkerTask): void {
    if (
      this.activeTask?.taskId === task.taskId
      && this.activeTask.attempt === task.attempt
    ) {
      this.activeTask = undefined;
    }
  }

  public evaluate(
    position: LeafPosition,
    signal?: AbortSignal,
  ): Promise<number> {
    if (this.closed) {
      return Promise.reject(new Error("Remote UCI leaf evaluator is closed."));
    }
    const task = this.activeTask;
    if (task === undefined) {
      return Promise.reject(
        new Error("Remote UCI leaf evaluation is outside an authenticated task."),
      );
    }
    if (this.pending.size > 0) {
      return Promise.reject(
        new Error("Concurrent remote UCI leaf evaluations are not supported."),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(createAbortError());
    }
    const evaluationId = this.nextEvaluationId;
    this.nextEvaluationId += 1;
    return new Promise<number>((resolve, reject) => {
      let removeAbortListener = (): void => undefined;
      const pending: PendingEvaluation = {
        ...task,
        resolve,
        reject,
        removeAbortListener: () => {
          removeAbortListener();
        },
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          if (!this.pending.delete(evaluationId)) {
            return;
          }
          removeAbortListener();
          this.ignored.set(evaluationId, task);
          try {
            this.port.postMessage(Object.freeze({
              schemaVersion: 2,
              kind: "player-private-worker-evaluation-cancel",
              ...this.identity,
              ...task,
              evaluationId,
            } satisfies PlayerPrivateWorkerEvaluationCancel));
          } catch {
            // The task failure/worker shutdown path owns parent-side cleanup.
          }
          reject(createAbortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }
      this.pending.set(evaluationId, pending);
      try {
        this.port.postMessage(Object.freeze({
          schemaVersion: 2,
          kind: "player-private-worker-evaluation-request",
          ...this.identity,
          ...task,
          evaluationId,
          position: snapshotPlayerPrivateUciLeafPosition(position),
        } satisfies PlayerPrivateWorkerEvaluationRequest));
      } catch (error: unknown) {
        this.pending.delete(evaluationId);
        removeAbortListener();
        reject(new UciTransportError(
          "Unable to dispatch a parent-owned UCI leaf evaluation.",
          { cause: error },
        ));
      }
    });
  }

  public handleParentMessage(value: unknown): boolean {
    const record = protocolRecord(value, "remote UCI evaluator response");
    if (!isPlayerPrivateWorkerEvaluationParentKind(record["kind"])) {
      return false;
    }
    const evaluationId = record["evaluationId"];
    if (!Number.isSafeInteger(evaluationId) || (evaluationId as number) < 0) {
      throw new TypeError("Remote UCI evaluator response ID is invalid.");
    }
    const id = evaluationId as number;
    const pending = this.pending.get(id);
    const ignored = this.ignored.get(id);
    const correlation = pending ?? ignored;
    if (correlation === undefined) {
      throw new TypeError("Remote UCI evaluator response is not pending.");
    }
    if (ignored !== undefined) {
      if (record["kind"] === "player-private-worker-evaluation-result") {
        assertPlayerPrivateWorkerEvaluationResult(
          value,
          this.identity,
          correlation.taskId,
          correlation.attempt,
        );
      } else {
        assertPlayerPrivateWorkerEvaluationFailure(
          value,
          this.identity,
          correlation.taskId,
          correlation.attempt,
        );
      }
      this.ignored.delete(id);
      return true;
    }
    if (pending === undefined) {
      throw new Error("Remote UCI evaluator lost a pending request.");
    }
    if (record["kind"] === "player-private-worker-evaluation-result") {
      assertPlayerPrivateWorkerEvaluationResult(
        value,
        this.identity,
        correlation.taskId,
        correlation.attempt,
      );
      this.pending.delete(id);
      pending.removeAbortListener();
      pending.resolve(value.score);
      return true;
    }
    assertPlayerPrivateWorkerEvaluationFailure(
      value,
      this.identity,
      correlation.taskId,
      correlation.attempt,
    );
    this.pending.delete(id);
    pending.removeAbortListener();
    pending.reject(remoteFailure(value.failure.code, value.failure.message));
    return true;
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.activeTask = undefined;
    for (const [evaluationId, pending] of this.pending) {
      pending.removeAbortListener();
      try {
        this.port.postMessage(Object.freeze({
          schemaVersion: 2,
          kind: "player-private-worker-evaluation-cancel",
          ...this.identity,
          taskId: pending.taskId,
          attempt: pending.attempt,
          evaluationId,
        } satisfies PlayerPrivateWorkerEvaluationCancel));
      } catch {
        // Parent-side slot shutdown still aborts and closes the owned engine.
      }
      pending.reject(createAbortError());
    }
    this.pending.clear();
    this.ignored.clear();
  }
}

function remoteFailure(
  code:
    | "unsupported-position"
    | "transient-evaluator"
    | "evaluation-aborted"
    | "evaluation-failed",
  message: string,
): Error {
  switch (code) {
    case "unsupported-position":
      return new UnsupportedDrawbackLeafPositionError(message);
    case "transient-evaluator":
      return new UciTransportError(message);
    case "evaluation-aborted":
      return createAbortError();
    case "evaluation-failed":
      return new Error(message);
  }
}

function createAbortError(): Error {
  const error = new Error("Remote UCI leaf evaluation was aborted.");
  error.name = "AbortError";
  return error;
}
