import {
  AuthenticatedNodeUciEngineCloseError,
  IncompleteSameOwnerCleanupError,
} from "@drawbackengine/chess-evaluator";
import { describe, expect, it, vi } from "vitest";
import { runWithOwnedProviderCleanup } from "./owned-provider-operation.js";

describe("owned provider operation", () => {
  it("preserves the operation failure and retains the exact incomplete owner", async () => {
    let cleanupAllowed = false;
    const dispose = vi.fn(() =>
      cleanupAllowed
        ? Promise.resolve()
        : Promise.reject(incompleteCleanupFailure())
    );
    const provider = { dispose };

    const failure = await runWithOwnedProviderCleanup(
      provider,
      () => Promise.reject(new Error("generation failed")),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IncompleteSameOwnerCleanupError);
    expect(allErrorMessages(failure)).toContain("generation failed");
    expect(allErrorMessages(failure)).toContain("cleanup incomplete");
    expect(dispose).toHaveBeenCalledTimes(3);
    if (!(failure instanceof IncompleteSameOwnerCleanupError)) {
      throw new Error("Expected retained same-owner cleanup.");
    }

    cleanupAllowed = true;
    await expect(failure.retryCleanup()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(4);
  });

  it("does not retry cleanup already proven complete", async () => {
    const completeFailure = new AuthenticatedNodeUciEngineCloseError(
      "cleanup completed abnormally",
      true,
      true,
    );
    const dispose = vi.fn(() => Promise.reject(completeFailure));

    await expect(runWithOwnedProviderCleanup(
      { dispose },
      () => Promise.resolve("unused"),
    )).rejects.toBe(completeFailure);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

function incompleteCleanupFailure(): AuthenticatedNodeUciEngineCloseError {
  return new AuthenticatedNodeUciEngineCloseError(
    "cleanup incomplete",
    false,
    false,
  );
}

function allErrorMessages(value: unknown): readonly string[] {
  const messages: string[] = [];
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause !== undefined) {
        pending.push(current.cause);
      }
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors as readonly unknown[]);
    }
  }
  return messages;
}
