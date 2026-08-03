import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportState = vi.hoisted(() => ({
  created: 0,
  closeOwnerIds: [] as number[],
  executablePaths: [] as string[],
}));

vi.mock("./node-process-transport.js", async () => {
  const { UciProcessTerminationError } = await import("./types.js");

  interface PendingRead {
    readonly resolve: (result: IteratorResult<string>) => void;
  }

  class RetryCleanupTransport {
    readonly #ownerId: number;
    readonly #lines: string[] = [];
    readonly #readers: PendingRead[] = [];
    #closed = false;
    #closeCalls = 0;

    public constructor(options: { readonly executablePath: string }) {
      this.#ownerId = transportState.created + 1;
      transportState.created += 1;
      transportState.executablePaths.push(options.executablePath);
    }

    public send(command: string): Promise<void> {
      if (command === "uci") {
        this.#enqueue("id name Unpinned Engine");
        this.#enqueue("uciok");
      } else if (command === "isready") {
        this.#enqueue("readyok");
      } else if (command !== "quit") {
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
      return Promise.resolve();
    }

    public lines(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => this.#read(),
        }),
      };
    }

    public close(): Promise<void> {
      this.#closeCalls += 1;
      transportState.closeOwnerIds.push(this.#ownerId);
      if (this.#closeCalls === 1) {
        return Promise.reject(new UciProcessTerminationError(
          "First shutdown did not prove process termination.",
          false,
        ));
      }
      this.#finish();
      return Promise.resolve();
    }

    #enqueue(line: string): void {
      const reader = this.#readers.shift();
      if (reader === undefined) {
        this.#lines.push(line);
      } else {
        reader.resolve({ done: false, value: line });
      }
    }

    #read(): Promise<IteratorResult<string>> {
      const line = this.#lines.shift();
      if (line !== undefined) {
        return Promise.resolve({ done: false, value: line });
      }
      if (this.#closed) {
        return Promise.resolve({ done: true, value: undefined });
      }
      return new Promise((resolve) => {
        this.#readers.push({ resolve });
      });
    }

    #finish(): void {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      for (const reader of this.#readers.splice(0)) {
        reader.resolve({ done: true, value: undefined });
      }
    }
  }

  return { NodeProcessUciTransport: RetryCleanupTransport };
});

import {
  AuthenticatedNodeUciEngineCloseError,
  AuthenticatedNodeUciEngineError,
  createAuthenticatedNodeUciEngine,
} from "./authenticated-node-uci-engine.js";

const EXECUTABLE_DIGEST = createHash("sha256")
  .update(await readFile(process.execPath))
  .digest("hex");

beforeEach(() => {
  transportState.created = 0;
  transportState.closeOwnerIds.splice(0);
  transportState.executablePaths.splice(0);
});

afterEach(async () => {
  const temporaryRoot = resolve(tmpdir());
  for (const executablePath of new Set(transportState.executablePaths)) {
    const directory = dirname(resolve(executablePath));
    if (
      dirname(directory) === temporaryRoot
      && basename(directory).startsWith("drawback-uci-")
    ) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("authenticated failure cleanup", () => {
  it("retries the same client once when the first close is unproven", async () => {
    let caught: unknown;
    try {
      await createAuthenticatedNodeUciEngine({
        process: {
          executablePath: process.execPath,
          executableSha256: EXECUTABLE_DIGEST,
          runtimeContextSha256: "b".repeat(64),
          shutdownTimeoutMs: 100,
        },
        client: { timeoutMs: 100 },
        engineIdentity: {
          uciName: "Pinned Engine",
          engine: "mock-engine",
          version: "1.0",
        },
        optionsDigest: "a".repeat(64),
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const failures = (caught as AggregateError).errors as readonly unknown[];
    expect(failures).toHaveLength(2);
    expect(failures[0]).toBeInstanceOf(AuthenticatedNodeUciEngineError);
    expect(failures[1]).toBeInstanceOf(
      AuthenticatedNodeUciEngineCloseError,
    );
    const firstCleanupFailure =
      failures[1] as AuthenticatedNodeUciEngineCloseError;
    expect(firstCleanupFailure.privateExecutableRemoved).toBe(true);
    expect(firstCleanupFailure.processTerminated).toBe(false);
    expect(transportState.created).toBe(1);
    expect(transportState.closeOwnerIds).toEqual([1, 1]);
    expect(transportState.executablePaths).toHaveLength(1);
    await expect(
      readFile(transportState.executablePaths[0] ?? ""),
    ).rejects.toThrow();
  });
});
