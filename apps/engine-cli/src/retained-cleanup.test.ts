import {
  IncompleteSameOwnerCleanupError,
} from "@drawbackengine/chess-evaluator";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PlayerPrivateWorkerPoolCleanupError,
  PlayerPrivateWorkerPoolCreationError,
} from "@drawbackengine/simulation-arena";
import { describe, expect, it, vi } from "vitest";
import { RetainedFileCleanupError } from "./atomic-ndjson.js";
import {
  findRetainedCleanupOwner,
  findRetainedCleanupOwners,
  retryRetainedCleanup,
} from "./retained-cleanup.js";

describe("retained player-private cleanup", () => {
  it("finds a pre-worker engine owner through nested failures and retries it", async () => {
    const original = new Error("UCI initialization failed.");
    const cleanupFailure = new Error("Process exit was not proven.");
    const retryCleanup = vi.fn(() => Promise.resolve());
    const retained = new IncompleteSameOwnerCleanupError(
      [original, cleanupFailure],
      "UCI initialization and cleanup failed.",
      retryCleanup,
    );
    const wrapped = new AggregateError(
      [new Error("Temporary file cleanup failed."), retained],
      "Generation failed.",
    );
    const cyclic = new Error("Outer failure.", { cause: wrapped });
    Object.defineProperty(wrapped, "cause", { value: cyclic });

    expect(findRetainedCleanupOwner(cyclic)).toBe(retained);
    const reported = await retryRetainedCleanup(cyclic);

    expect(retryCleanup).toHaveBeenCalledTimes(1);
    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as AggregateError).errors[0]).toBe(cyclic);
  });

  it("keeps the retained owner discoverable when retries remain incomplete", async () => {
    const retained = new IncompleteSameOwnerCleanupError(
      [new Error("Initialization failed.")],
      "Cleanup failed.",
      () => Promise.reject(new Error("Still running.")),
    );

    const reported = await retryRetainedCleanup(retained, 2);

    expect(reported).toBeInstanceOf(AggregateError);
    expect(findRetainedCleanupOwner(reported)).toBeInstanceOf(
      IncompleteSameOwnerCleanupError,
    );
  });

  it("deduplicates fresh retained wrappers when cleanup is retried again", async () => {
    const retryCleanup = vi.fn(() => Promise.reject(
      new Error("Same resource remains active."),
    ));
    const retained = new IncompleteSameOwnerCleanupError(
      [new Error("Initialization failed.")],
      "Cleanup failed.",
      retryCleanup,
    );

    const first = await retryRetainedCleanup(retained, 2);
    expect(retryCleanup).toHaveBeenCalledTimes(2);
    expect(findRetainedCleanupOwners(first)).toHaveLength(1);

    const second = await retryRetainedCleanup(first, 1);
    expect(retryCleanup).toHaveBeenCalledTimes(3);
    expect(findRetainedCleanupOwners(second)).toHaveLength(1);
  });

  it("drains every distinct pre-worker cleanup owner", async () => {
    const firstRetry = vi.fn(() => Promise.resolve());
    const secondRetry = vi.fn(() => Promise.resolve());
    const first = new IncompleteSameOwnerCleanupError(
      [new Error("First initialization failed.")],
      "First cleanup failed.",
      firstRetry,
    );
    const second = new IncompleteSameOwnerCleanupError(
      [new Error("Second initialization failed.")],
      "Second cleanup failed.",
      secondRetry,
    );
    const failure = new AggregateError(
      [first, new Error("Unrelated failure."), second],
      "Multiple slots failed.",
    );

    expect(findRetainedCleanupOwners(failure)).toEqual([second, first]);
    const reported = await retryRetainedCleanup(failure);

    expect(firstRetry).toHaveBeenCalledTimes(1);
    expect(secondRetry).toHaveBeenCalledTimes(1);
    expect((reported as Error).message).toContain(
      "retained cleanup completed",
    );
  });

  it("does not mistake nested historical owners for an incomplete outer retry", async () => {
    const innerRetry = vi.fn(() => Promise.resolve());
    const inner = new IncompleteSameOwnerCleanupError(
      [new Error("Inner initialization failed.")],
      "Inner cleanup failed.",
      innerRetry,
    );
    const outerRetry = vi.fn(() => Promise.reject(new AggregateError(
      [inner, new Error("Outer cleanup completed with a terminal error.")],
      "Outer cleanup completed abnormally.",
    )));
    const outer = new IncompleteSameOwnerCleanupError(
      [new Error("Outer initialization failed."), inner],
      "Outer cleanup failed.",
      outerRetry,
      () => true,
    );

    const reported = await retryRetainedCleanup(outer, 2);

    expect(innerRetry).toHaveBeenCalledTimes(1);
    expect(outerRetry).toHaveBeenCalledTimes(1);
    expect((reported as Error).message).toBe(
      "Player-private generation failed after retained cleanup completed.",
    );
  });

  it("does not duplicate a pool owner through a creation error", async () => {
    const retryPool = vi.fn(() => Promise.resolve());
    const diagnostics = () => ({
      configuredWorkers: 1,
      launches: 1,
      activeWorkers: 1,
      peakActiveWorkers: 1,
      completedTasks: 0,
      retriedTasks: 0,
    });
    const cleanup = new PlayerPrivateWorkerPoolCleanupError(
      [new Error("Slot termination failed.")],
      "Pool cleanup failed.",
      retryPool,
      diagnostics,
    );
    const creation = new PlayerPrivateWorkerPoolCreationError(
      new Error("Pool initialization failed."),
      cleanup,
      retryPool,
      diagnostics,
    );

    expect(findRetainedCleanupOwners(creation)).toEqual([creation]);
    await retryRetainedCleanup(creation);
    expect(retryPool).toHaveBeenCalledTimes(1);
  });

  it("removes a retained private file through the same cleanup pipeline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retained-file-test-"));
    const path = join(directory, "private.ndjson");
    await writeFile(path, "private\n", { encoding: "utf8", mode: 0o600 });
    try {
      const retained = new RetainedFileCleanupError(
        [new Error("Initial removal failed.")],
        [path],
      );

      await retryRetainedCleanup(retained);

      await expect(access(path)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
