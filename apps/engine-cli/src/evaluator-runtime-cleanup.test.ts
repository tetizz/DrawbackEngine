import { describe, expect, it, vi } from "vitest";
import { NodeUciLeafEvaluatorCloseError } from "@drawbackengine/chess-evaluator";
import { closeEvaluatorRuntime } from "./evaluator-runtime-cleanup.js";

describe("closeEvaluatorRuntime", () => {
  it("retries an incomplete close through the same runtime owner", async () => {
    const incomplete = new NodeUciLeafEvaluatorCloseError(
      "first close was incomplete",
      false,
      false,
    );
    const close = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(incomplete)
      .mockResolvedValueOnce(undefined);

    await expect(closeEvaluatorRuntime({ close })).rejects.toBe(incomplete);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("does not retry a close failure that proves cleanup complete", async () => {
    const complete = new NodeUciLeafEvaluatorCloseError(
      "shutdown reported an error after cleanup",
      true,
      true,
    );
    const close = vi.fn<() => Promise<void>>().mockRejectedValue(complete);

    await expect(closeEvaluatorRuntime({ close })).rejects.toBe(complete);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated incomplete close attempts", async () => {
    const incomplete = new NodeUciLeafEvaluatorCloseError(
      "close remained incomplete",
      false,
      false,
    );
    const close = vi.fn<() => Promise<void>>().mockRejectedValue(incomplete);

    await expect(closeEvaluatorRuntime({ close })).rejects.toMatchObject({
      name: "IncompleteSameOwnerCleanupError",
    });
    expect(close).toHaveBeenCalledTimes(3);
  });
});
