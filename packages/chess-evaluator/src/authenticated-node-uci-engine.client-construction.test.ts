import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructionState = vi.hoisted(() => ({
  clientConstructions: 0,
  clientFailure: new Error("Synthetic UCI client construction failure."),
  transportCreations: 0,
  transportCloseOwnerIds: [] as number[],
  executablePaths: [] as string[],
}));

vi.mock("./client.js", () => {
  function ThrowingUciClient(): never {
    constructionState.clientConstructions += 1;
    throw constructionState.clientFailure;
  }
  return { UciClient: ThrowingUciClient };
});

vi.mock("./node-process-transport.js", async () => {
  const { UciProcessTerminationError } = await import("./types.js");

  class RetainedTransport {
    readonly #ownerId: number;
    #closeCalls = 0;

    public constructor(options: { readonly executablePath: string }) {
      this.#ownerId = constructionState.transportCreations + 1;
      constructionState.transportCreations += 1;
      constructionState.executablePaths.push(options.executablePath);
    }

    public close(): Promise<void> {
      this.#closeCalls += 1;
      constructionState.transportCloseOwnerIds.push(this.#ownerId);
      if (this.#closeCalls === 1) {
        return Promise.reject(new UciProcessTerminationError(
          "First direct transport close did not prove termination.",
          false,
        ));
      }
      return Promise.resolve();
    }
  }

  return { NodeProcessUciTransport: RetainedTransport };
});

import {
  AuthenticatedNodeUciEngineCloseError,
  createAuthenticatedNodeUciEngine,
} from "./authenticated-node-uci-engine.js";

const EXECUTABLE_DIGEST = createHash("sha256")
  .update(await readFile(process.execPath))
  .digest("hex");

beforeEach(() => {
  constructionState.clientConstructions = 0;
  constructionState.clientFailure = new Error(
    "Synthetic UCI client construction failure.",
  );
  constructionState.transportCreations = 0;
  constructionState.transportCloseOwnerIds.splice(0);
  constructionState.executablePaths.splice(0);
});

afterEach(async () => {
  const temporaryRoot = resolve(tmpdir());
  for (const executablePath of new Set(constructionState.executablePaths)) {
    const directory = dirname(resolve(executablePath));
    if (
      dirname(directory) === temporaryRoot
      && basename(directory).startsWith("drawback-uci-")
    ) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("UCI client construction cleanup", () => {
  it("retains and retries the spawned transport when client construction throws", async () => {
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
    expect(failures[0]).toBe(constructionState.clientFailure);
    expect(failures[1]).toBeInstanceOf(
      AuthenticatedNodeUciEngineCloseError,
    );
    const firstCleanupFailure =
      failures[1] as AuthenticatedNodeUciEngineCloseError;
    expect(firstCleanupFailure.privateExecutableRemoved).toBe(true);
    expect(firstCleanupFailure.processTerminated).toBe(false);
    expect(constructionState.clientConstructions).toBe(1);
    expect(constructionState.transportCreations).toBe(1);
    expect(constructionState.transportCloseOwnerIds).toEqual([1, 1]);
    expect(constructionState.executablePaths).toHaveLength(1);
    await expect(
      readFile(constructionState.executablePaths[0] ?? ""),
    ).rejects.toThrow();
  });
});
