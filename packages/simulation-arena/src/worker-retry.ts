export const DEFAULT_PARALLEL_WORKER_ATTEMPTS = 3;

export type TransientParallelWorkerFailureCode =
  | "worker-initialization-timeout"
  | "worker-process-error"
  | "worker-process-exit"
  | "worker-post-message"
  | "worker-reported-transient";

/**
 * Marks a process or transport failure that is safe to retry with an
 * unchanged immutable request.
 */
export class TransientParallelWorkerError extends Error {
  public readonly code: TransientParallelWorkerFailureCode;

  public constructor(
    code: TransientParallelWorkerFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TransientParallelWorkerError";
    this.code = code;
  }
}

export function isTransientParallelWorkerError(
  value: unknown,
): value is TransientParallelWorkerError {
  return value instanceof TransientParallelWorkerError;
}

export function findTransientParallelWorkerError(
  value: unknown,
): TransientParallelWorkerError | undefined {
  const seen = new Set<unknown>();
  let current = value;
  while (current instanceof Error && !seen.has(current)) {
    if (isTransientParallelWorkerError(current)) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

export async function retryParallelWorkerOperation<T>(
  operation: (attempt: number) => Promise<T>,
  attempts = DEFAULT_PARALLEL_WORKER_ATTEMPTS,
): Promise<T> {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new RangeError("parallel worker attempts must be a positive safe integer.");
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error: unknown) {
      if (!isTransientParallelWorkerError(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  const lastMessage =
    lastError instanceof Error
      ? lastError.message
      : "Unknown parallel worker failure.";
  throw new Error(
    `Parallel simulation worker failed after ${String(attempts)} attempts: `
      + lastMessage,
    { cause: lastError },
  );
}
