export const DEFAULT_PARALLEL_WORKER_ATTEMPTS = 3;

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
      lastError = error;
    }
  }
  throw new Error(
    `Parallel simulation worker failed after ${String(attempts)} attempts.`,
    { cause: lastError },
  );
}
