import {
  AuthenticatedNodeUciEngineCloseError,
  throwAfterSameOwnerCleanup,
} from "@drawbackengine/chess-evaluator";

export interface OwnedAsyncProvider {
  dispose(): Promise<void>;
}

type OperationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error };

/**
 * Runs one operation and then disposes its exact provider owner. If disposal
 * remains incomplete, the thrown cleanup error retains that same provider for
 * bounded retry instead of losing the only handle capable of finishing it.
 */
export async function runWithOwnedProviderCleanup<T>(
  provider: OwnedAsyncProvider,
  operation: () => Promise<T>,
): Promise<T> {
  const outcome: OperationOutcome<T> = await Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        error: errorFromUnknown(error),
      }),
    );

  let cleanupFailure: Error | undefined;
  try {
    await provider.dispose();
  } catch (error: unknown) {
    cleanupFailure = errorFromUnknown(error);
  }

  if (cleanupFailure === undefined) {
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  const preservedFailure = outcome.ok
    ? cleanupFailure
    : new AggregateError(
        [outcome.error, cleanupFailure],
        "Evaluator sidecar generation and provider cleanup both failed.",
      );
  if (providerCleanupProvesComplete(cleanupFailure)) {
    throw preservedFailure;
  }
  return throwAfterSameOwnerCleanup(
    preservedFailure,
    () => provider.dispose(),
    "Evaluator sidecar provider cleanup remains incomplete.",
    providerCleanupProvesComplete,
  );
}

function providerCleanupProvesComplete(error: unknown): boolean {
  return error instanceof AuthenticatedNodeUciEngineCloseError
    && error.privateExecutableRemoved
    && error.processTerminated;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("An operation failed with a non-Error value.", {
        cause: error,
      });
}
