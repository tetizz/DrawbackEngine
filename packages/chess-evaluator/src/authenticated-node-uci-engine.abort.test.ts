import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  initializeSignal: undefined as AbortSignal | undefined,
  closeCalls: 0,
}));

vi.mock("./client.js", () => ({
  UciClient: class {
    public initialize(options: { readonly signal?: AbortSignal } = {}): Promise<never> {
      state.initializeSignal = options.signal;
      return new Promise((_, reject) => {
        const signal = options.signal;
        if (signal === undefined) {
          return;
        }
        const rejectAborted = (): void => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("Startup aborted.", "AbortError"),
          );
        };
        signal.addEventListener("abort", rejectAborted, { once: true });
        if (signal.aborted) {
          signal.removeEventListener("abort", rejectAborted);
          rejectAborted();
        }
      });
    }

    public configuredOption(): undefined {
      return undefined;
    }

    public close(): Promise<void> {
      state.closeCalls += 1;
      return Promise.resolve();
    }
  },
}));

vi.mock("./node-process-transport.js", () => ({
  NodeProcessUciTransport: class {
    public close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import { createAuthenticatedNodeUciEngine } from "./authenticated-node-uci-engine.js";

// The transport is mocked in this signal-propagation unit test, so authenticate
// a small stable fixture instead of copying the full Node executable. The real
// executable startup and cancellation path has its own integration test.
const EXECUTABLE_FIXTURE = fileURLToPath(import.meta.url);
const EXECUTABLE_DIGEST = createHash("sha256")
  .update(await readFile(EXECUTABLE_FIXTURE))
  .digest("hex");

describe("authenticated UCI startup cancellation", () => {
  it("passes cancellation into initialization and cleans up the same owner", async () => {
    state.initializeSignal = undefined;
    state.closeCalls = 0;
    const controller = new AbortController();
    const reason = new Error("Stop startup now.");
    const started = createAuthenticatedNodeUciEngine(
      {
        process: {
          executablePath: EXECUTABLE_FIXTURE,
          executableSha256: EXECUTABLE_DIGEST,
          runtimeContextSha256: "b".repeat(64),
          shutdownTimeoutMs: 100,
        },
        client: { timeoutMs: 1_000 },
        engineIdentity: {
          uciName: "Pinned Engine",
          engine: "mock-engine",
          version: "1.0",
        },
        optionsDigest: "a".repeat(64),
      },
      { signal: controller.signal },
    );
    const settled = started.then(
      () => undefined,
      () => undefined,
    );

    try {
      await vi.waitFor(() => {
        expect(state.initializeSignal).toBe(controller.signal);
      }, { timeout: 5_000, interval: 20 });
      controller.abort(reason);

      await expect(started).rejects.toBe(reason);
      expect(state.closeCalls).toBe(1);
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
      await settled;
    }
  });

  it("does not stage or spawn when already aborted", async () => {
    state.initializeSignal = undefined;
    state.closeCalls = 0;
    const controller = new AbortController();
    const reason = new Error("Already stopped.");
    controller.abort(reason);

    await expect(createAuthenticatedNodeUciEngine(
      {
        process: {
          executablePath: EXECUTABLE_FIXTURE,
          executableSha256: EXECUTABLE_DIGEST,
          runtimeContextSha256: "b".repeat(64),
          shutdownTimeoutMs: 100,
        },
        client: { timeoutMs: 1_000 },
        engineIdentity: {
          uciName: "Pinned Engine",
          engine: "mock-engine",
          version: "1.0",
        },
        optionsDigest: "a".repeat(64),
      },
      { signal: controller.signal },
    )).rejects.toBe(reason);
    expect(state.initializeSignal).toBeUndefined();
    expect(state.closeCalls).toBe(0);
  });
});
