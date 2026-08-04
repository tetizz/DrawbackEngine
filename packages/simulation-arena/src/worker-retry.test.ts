import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PARALLEL_WORKER_ATTEMPTS,
  TransientParallelWorkerError,
  findTransientParallelWorkerError,
  retryParallelWorkerOperation,
} from "./worker-retry.js";

describe("parallel worker retry", () => {
  it("retries an isolated worker failure without changing the request", async () => {
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new TransientParallelWorkerError(
        "worker-process-exit",
        "UCI process exited",
      ))
      .mockResolvedValue("complete");

    await expect(retryParallelWorkerOperation(operation)).resolves.toBe(
      "complete",
    );
    expect(operation.mock.calls).toEqual([[1], [2]]);
  });

  it("fails with the last worker error after the bounded attempt count", async () => {
    const finalError = new TransientParallelWorkerError(
      "worker-process-error",
      "worker still unavailable",
    );
    const operation = vi
      .fn<(attempt: number) => Promise<never>>()
      .mockRejectedValueOnce(new TransientParallelWorkerError(
        "worker-process-error",
        "first failure",
      ))
      .mockRejectedValue(finalError);

    const failure = await retryParallelWorkerOperation(
      operation,
      DEFAULT_PARALLEL_WORKER_ATTEMPTS,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("after 3 attempts");
    expect((failure as Error).message).toContain(
      "worker still unavailable",
    );
    expect((failure as Error).cause).toBe(finalError);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry a permanent operation or protocol failure", async () => {
    const permanent = new TypeError("forged task response");
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValue(permanent);

    await expect(retryParallelWorkerOperation(operation)).rejects.toBe(
      permanent,
    );
    expect(operation.mock.calls).toEqual([[1]]);
  });

  it("finds a typed transient failure through contextual error causes", () => {
    const transient = new TransientParallelWorkerError(
      "worker-process-exit",
      "evaluator exited",
    );
    const wrapped = new Error(
      "search failed",
      { cause: new Error("move failed", { cause: transient }) },
    );

    expect(findTransientParallelWorkerError(wrapped)).toBe(transient);
    expect(findTransientParallelWorkerError(new Error("permanent"))).toBe(
      undefined,
    );
  });

  it("rejects invalid attempt counts before running work", async () => {
    const operation = vi.fn<() => Promise<string>>();
    await expect(retryParallelWorkerOperation(operation, 0)).rejects.toThrow(
      /positive safe integer/u,
    );
    expect(operation).not.toHaveBeenCalled();
  });
});
