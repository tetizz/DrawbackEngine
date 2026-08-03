import type { PathLike, RmOptions } from "node:fs";
import type * as FileSystemPromises from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cleanupState = vi.hoisted(() => ({
  privatePaths: [] as string[],
  removeCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  return {
    ...actual,
    rm: async (path: PathLike, options?: RmOptions): Promise<void> => {
      const text = String(path);
      if (text.includes("drawbackengine-fairy-")) {
        cleanupState.privatePaths.push(text);
        cleanupState.removeCalls += 1;
        if (cleanupState.removeCalls <= 2) {
          throw new Error("Synthetic private variant removal failure.");
        }
      }
      await actual.rm(path, options);
    },
  };
});

import { rm } from "node:fs/promises";
import { UciClient } from "./client.js";
import {
  initializeFairyStockfishLeafEvaluator,
} from "./fairy-stockfish-leaf-evaluator.js";
import {
  IncompleteSameOwnerCleanupError,
} from "./authenticated-node-uci-engine.js";
import { MockUciTransport } from "./mock-transport.js";

const VARIANT_PATH = resolve("data/catalog/drawbackchess-fairy-v1.ini");

beforeEach(() => {
  cleanupState.privatePaths.splice(0);
  cleanupState.removeCalls = 0;
});

afterEach(async () => {
  for (const path of new Set(cleanupState.privatePaths)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("Fairy private initialization cleanup", () => {
  it("retains the private variant path until the same owner removes it", async () => {
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: ["id name Fairy Cleanup Test", "uciok"],
      },
      { command: "isready", responses: ["readyok"] },
      { command: "quit" },
    ]);
    const client = new UciClient(transport);
    const failure = await initializeFairyStockfishLeafEvaluator({
      client,
      depth: 1,
      variantPath: VARIANT_PATH,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IncompleteSameOwnerCleanupError);
    expect(cleanupState.removeCalls).toBe(2);
    expect(transport.complete).toBe(true);
    if (!(failure instanceof IncompleteSameOwnerCleanupError)) {
      throw new Error("Expected retained Fairy private configuration.");
    }

    await expect(failure.retryCleanup()).resolves.toBeUndefined();
    expect(cleanupState.removeCalls).toBe(3);
  });
});
