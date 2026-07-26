import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PARALLEL_WORKER_ATTEMPTS,
  retryParallelWorkerOperation,
} from "./worker-retry.js";

describe("parallel worker retry", () => {
  it("retries an isolated worker failure without changing the request", async () => {
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error("UCI process exited"))
      .mockResolvedValue("complete");

    await expect(retryParallelWorkerOperation(operation)).resolves.toBe(
      "complete",
    );
    expect(operation.mock.calls).toEqual([[1], [2]]);
  });

  it("fails with the last worker error after the bounded attempt count", async () => {
    const finalError = new Error("worker still unavailable");
    const operation = vi
      .fn<(attempt: number) => Promise<never>>()
      .mockRejectedValueOnce(new Error("first failure"))
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

  it("rejects invalid attempt counts before running work", async () => {
    const operation = vi.fn<() => Promise<string>>();
    await expect(retryParallelWorkerOperation(operation, 0)).rejects.toThrow(
      /positive safe integer/u,
    );
    expect(operation).not.toHaveBeenCalled();
  });
});
