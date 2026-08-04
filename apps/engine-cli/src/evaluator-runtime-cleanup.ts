import {
  NodeUciLeafEvaluatorCloseError,
  throwAfterSameOwnerCleanup,
} from "@drawbackengine/chess-evaluator";

export interface ClosableEvaluatorRuntime {
  close(): Promise<void>;
}

/**
 * Closes the evaluator through its original owner. An incomplete close gets one
 * bounded retry; a failure that already proves cleanup complete is preserved
 * without retrying or creating a replacement owner.
 */
export async function closeEvaluatorRuntime(
  runtime: ClosableEvaluatorRuntime,
): Promise<void> {
  try {
    await runtime.close();
  } catch (error: unknown) {
    if (
      error instanceof NodeUciLeafEvaluatorCloseError
      && (!error.privateResourcesRemoved || !error.processTerminated)
    ) {
      await throwAfterSameOwnerCleanup(
        error,
        () => runtime.close(),
        "Evaluator cleanup remained incomplete after a same-owner retry.",
        evaluatorCleanupProvesComplete,
      );
    }
    throw error;
  }
}

function evaluatorCleanupProvesComplete(error: unknown): boolean {
  return error instanceof NodeUciLeafEvaluatorCloseError
    && error.privateResourcesRemoved
    && error.processTerminated;
}
