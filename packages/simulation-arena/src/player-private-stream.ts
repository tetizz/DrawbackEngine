import {
  assertPlayerPrivateGameAssignment,
  assertPlayerPrivateSearchPolicy,
  assertPositiveSafeInteger,
  type PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";
import type {
  PlayerPrivateSimulationResult,
} from "./player-private-simulation.js";
import {
  PLAYER_PRIVATE_DATA_SPLITS,
  type ScheduledPlayerPrivateAssignment,
} from "./player-private-assignment-scheduler.js";
import {
  createPlayerPrivateWorkerPool,
  type PlayerPrivateWorkerPool,
} from "./player-private-worker-pool.js";

export interface PlayerPrivateAssignmentStreamRequest {
  readonly assignments: Iterable<ScheduledPlayerPrivateAssignment>;
  readonly workers: number;
  readonly policy: PlayerPrivateSearchPolicy;
  readonly maxPlies?: number;
  readonly windowSize?: number;
  readonly signal?: AbortSignal;
}

export interface StreamedPlayerPrivateResult
  extends ScheduledPlayerPrivateAssignment {
  readonly result: PlayerPrivateSimulationResult;
}

/**
 * Simulates a lazy assignment schedule with bounded materialization.
 *
 * Results are yielded in exact global-index order. At most `windowSize`
 * assignments and results are retained by this coordinator at a time.
 */
export function streamPlayerPrivateAssignmentsParallel(
  request: PlayerPrivateAssignmentStreamRequest,
): AsyncIterable<StreamedPlayerPrivateResult> {
  assertPositiveSafeInteger(request.workers, "workers");
  assertPlayerPrivateSearchPolicy(request.policy);
  if (request.maxPlies !== undefined) {
    assertPositiveSafeInteger(request.maxPlies, "maxPlies");
  }
  const defaultWindow = Math.max(request.workers * 4, request.workers);
  const windowSize = request.windowSize ?? defaultWindow;
  assertPositiveSafeInteger(windowSize, "windowSize");
  const iterator = request.assignments[Symbol.iterator]();
  const policy = freezeRecursively(structuredClone(request.policy));
  return streamWindows(
    iterator,
    request.workers,
    policy,
    windowSize,
    request.maxPlies,
    request.signal,
  );
}

async function* streamWindows(
  iterator: Iterator<ScheduledPlayerPrivateAssignment>,
  workers: number,
  policy: PlayerPrivateSearchPolicy,
  windowSize: number,
  maxPlies?: number,
  signal?: AbortSignal,
): AsyncGenerator<StreamedPlayerPrivateResult> {
  let previous: ScheduledPlayerPrivateAssignment | undefined;
  let pool: PlayerPrivateWorkerPool | undefined;
  let streamFailed = false;
  let streamFailure: unknown;
  let poolCleanup: Promise<void> | undefined;
  const closePool = (): Promise<void> => {
    poolCleanup ??= Promise.resolve().then(() => pool?.close());
    return poolCleanup;
  };
  try {
    for (;;) {
      throwIfAborted(signal);
      const window: ScheduledPlayerPrivateAssignment[] = [];
      while (window.length < windowSize) {
        throwIfAborted(signal);
        const next = iterator.next();
        if (next.done === true) {
          break;
        }
        assertScheduledAssignment(next.value, previous);
        const immutable = freezeRecursively(structuredClone(next.value));
        window.push(immutable);
        previous = immutable;
      }
      if (window.length === 0) {
        return;
      }
      pool ??= await createPlayerPrivateWorkerPool({
        workers: Math.min(workers, windowSize, window.length),
        policy,
        ...(maxPlies === undefined ? {} : { maxPlies }),
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfAborted(signal);
      let results: ReadonlyMap<number, PlayerPrivateSimulationResult>;
      try {
        const indexed = await runBatchAbortably(
          pool.runBatch(
            window.map(({ globalIndex, assignment }) =>
              Object.freeze({ gameIndex: globalIndex, assignment })
            ),
          ),
          signal,
          closePool,
        );
        results = new Map(
          indexed.map(({ gameIndex, result }) => [gameIndex, result]),
        );
      } catch (error: unknown) {
        const first = window[0];
        const last = window.at(-1);
        if (first === undefined || last === undefined) {
          throw new Error(
            "Player-private stream lost its non-empty window.",
            { cause: error },
          );
        }
        const message =
          error instanceof Error ? error.message : "Unknown worker failure.";
        throw new Error(
          `Player-private stream window ${String(first.globalIndex)}-`
            + `${String(last.globalIndex)} failed: ${message}`,
          { cause: error },
        );
      }
      if (results.size !== window.length) {
        throw new Error(
          "Player-private stream window returned incomplete results.",
        );
      }
      for (const scheduled of window) {
        throwIfAborted(signal);
        const result = results.get(scheduled.globalIndex);
        if (result === undefined) {
          throw new Error("Player-private stream lost a scheduled result.");
        }
        yield Object.freeze({
          ...scheduled,
          result,
        });
      }
    }
  } catch (error: unknown) {
    streamFailed = true;
    streamFailure = error;
    throw error;
  } finally {
    await finishStreamCleanup(
      closePool,
      iterator,
      streamFailed,
      streamFailure,
    );
  }
}

async function finishStreamCleanup(
  closePool: () => Promise<void>,
  iterator: Iterator<ScheduledPlayerPrivateAssignment>,
  streamFailed: boolean,
  streamFailure: unknown,
): Promise<void> {
  const cleanupFailures: unknown[] = [];
  try {
    await closePool();
  } catch (error: unknown) {
    cleanupFailures.push(error);
  }
  try {
    iterator.return?.();
  } catch (error: unknown) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      streamFailed
        ? [streamFailure, ...cleanupFailures]
        : cleanupFailures,
      streamFailed
        ? "Player-private streaming and retained cleanup both failed."
        : "Player-private stream cleanup failed.",
    );
  }
}

function runBatchAbortably<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  closePool: () => Promise<void>,
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
      const interruption = abortReason(signal);
      void Promise.allSettled([operation, closePool()]).then((results) => {
        const failures: unknown[] = [interruption];
        for (const result of results) {
          if (result.status === "rejected") {
            failures.push(result.reason as unknown);
          }
        }
        reject(failures.length === 1
          ? interruption
          : new AggregateError(
              failures,
              "Player-private stream interruption cleanup failed.",
            ));
      });
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
            : new Error("Player-private batch failed.", { cause: error }));
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
    : new Error("Player-private stream was interrupted.", {
        cause: signal.reason,
      });
}

function assertScheduledAssignment(
  value: ScheduledPlayerPrivateAssignment,
  previous: ScheduledPlayerPrivateAssignment | undefined,
): void {
  if (
    !Number.isSafeInteger(value.globalIndex)
    || value.globalIndex < 0
    || !Number.isSafeInteger(value.splitIndex)
    || value.splitIndex < 0
    || !PLAYER_PRIVATE_DATA_SPLITS.includes(value.split)
  ) {
    throw new RangeError("Scheduled assignment indices or split are invalid.");
  }
  assertPlayerPrivateGameAssignment(value.assignment);
  if (
    previous !== undefined
    && value.globalIndex !== previous.globalIndex + 1
  ) {
    throw new RangeError(
      "Scheduled assignments must have contiguous increasing global indexes.",
    );
  }
  if (previous === undefined) {
    return;
  }
  const previousSplit = PLAYER_PRIVATE_DATA_SPLITS.indexOf(previous.split);
  const currentSplit = PLAYER_PRIVATE_DATA_SPLITS.indexOf(value.split);
  if (
    currentSplit < previousSplit
    || (
      currentSplit === previousSplit
      && value.splitIndex !== previous.splitIndex + 1
    )
    || (currentSplit > previousSplit && value.splitIndex !== 0)
  ) {
    throw new RangeError(
      "Scheduled assignments must preserve split and split-index order.",
    );
  }
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
