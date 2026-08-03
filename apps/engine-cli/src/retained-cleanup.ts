import {
  IncompleteSameOwnerCleanupError,
} from "@drawbackengine/chess-evaluator";
import {
  PlayerPrivateWorkerPoolCleanupError,
} from "@drawbackengine/simulation-arena";
import { RetainedFileCleanupError } from "./atomic-ndjson.js";

type RetainedCleanupOwner =
  | PlayerPrivateWorkerPoolCleanupError
  | IncompleteSameOwnerCleanupError
  | RetainedFileCleanupError;

export async function retryRetainedCleanup(
  error: unknown,
  attempts = 2,
): Promise<unknown> {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new RangeError("Retained cleanup attempts must be positive.");
  }
  const cleanupOwners = findRetainedCleanupOwners(error);
  if (cleanupOwners.length === 0) {
    return error;
  }
  const outcomes = await Promise.all(
    cleanupOwners.map((owner) => retryCleanupOwner(owner, attempts)),
  );
  const cleanupFailures = outcomes.flatMap((outcome) => outcome.failures);
  const completedIdentities = new Set(
    outcomes
      .filter((outcome) => outcome.complete)
      .map((outcome) => outcome.owner.cleanupOwnerIdentity()),
  );
  const newlyRetainedOwners = findRetainedCleanupOwners(
    new AggregateError(cleanupFailures),
  ).filter(
    (owner) => !completedIdentities.has(owner.cleanupOwnerIdentity()),
  );
  const incomplete = outcomes.some((outcome) => !outcome.complete)
    || newlyRetainedOwners.length > 0;
  return new AggregateError(
    [error, ...cleanupFailures],
    incomplete
      ? "Player-private generation failed and retained cleanup remains incomplete."
      : "Player-private generation failed after retained cleanup completed.",
  );
}

export function findRetainedCleanupOwner(
  value: unknown,
): RetainedCleanupOwner | undefined {
  return findRetainedCleanupOwners(value)[0];
}

export function findRetainedCleanupOwners(
  value: unknown,
): readonly RetainedCleanupOwner[] {
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  const seenOwnerIdentities = new Set<object>();
  const owners: RetainedCleanupOwner[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (
      current instanceof PlayerPrivateWorkerPoolCleanupError
      || current instanceof IncompleteSameOwnerCleanupError
      || current instanceof RetainedFileCleanupError
    ) {
      const identity = current.cleanupOwnerIdentity();
      if (!seenOwnerIdentities.has(identity)) {
        seenOwnerIdentities.add(identity);
        owners.push(current);
      }
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors as readonly unknown[]);
    }
    if (current instanceof Error && current.cause !== undefined) {
      pending.push(current.cause);
    }
  }
  return owners;
}

async function retryCleanupOwner(
  owner: RetainedCleanupOwner,
  attempts: number,
): Promise<{
  readonly owner: RetainedCleanupOwner;
  readonly complete: boolean;
  readonly failures: readonly unknown[];
}> {
  const failures: unknown[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await owner.retryCleanup();
      return { owner, complete: true, failures };
    } catch (cleanupFailure: unknown) {
      failures.push(cleanupFailure);
      if (!isIncompleteRetryForOwner(owner, cleanupFailure)) {
        return { owner, complete: true, failures };
      }
    }
  }
  return { owner, complete: false, failures };
}

function isIncompleteRetryForOwner(
  owner: RetainedCleanupOwner,
  failure: unknown,
): boolean {
  if (owner instanceof PlayerPrivateWorkerPoolCleanupError) {
    return failure instanceof PlayerPrivateWorkerPoolCleanupError
      && failure.cleanupOwnerIdentity() === owner.cleanupOwnerIdentity();
  }
  if (owner instanceof IncompleteSameOwnerCleanupError) {
    return failure instanceof IncompleteSameOwnerCleanupError
      && failure.cleanupOwnerIdentity() === owner.cleanupOwnerIdentity();
  }
  return failure instanceof RetainedFileCleanupError
    && failure.cleanupOwnerIdentity() === owner.cleanupOwnerIdentity();
}
