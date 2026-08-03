import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeOwner {
  readonly id: number;
  closeCalls: number;
}

const factoryState = vi.hoisted(() => ({
  created: 0,
  owners: [] as FakeOwner[],
  constructionFailure: new Error("Synthetic evaluator construction failure."),
}));

vi.mock("./authenticated-node-uci-engine.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const CloseError = actual["AuthenticatedNodeUciEngineCloseError"] as new (
    message: string,
    privateExecutableRemoved: boolean,
    processTerminated: boolean,
  ) => Error;
  return {
    ...actual,
    createAuthenticatedNodeUciEngine: () => {
      const owner: FakeOwner = {
        id: factoryState.created + 1,
        closeCalls: 0,
      };
      factoryState.created += 1;
      factoryState.owners.push(owner);
      return Promise.resolve({
        client: {
          identity: {
            name: "Different borrowed client",
            author: null,
            options: [],
          },
        },
        identity: {
          name: "Pinned Engine",
          author: null,
          options: [],
        },
        fingerprint: {
          engine: "mock-engine",
          version: "1.0",
          optionsDigest: "a".repeat(64),
        },
        executableSha256: "b".repeat(64),
        publicFingerprint:
          `mock-engine:1.0:${"b".repeat(64)}:${"a".repeat(64)}`,
        close: () => {
          owner.closeCalls += 1;
          if (owner.closeCalls === 1) {
            return Promise.reject(new CloseError(
              "First owner close did not prove cleanup.",
              false,
              false,
            ));
          }
          return Promise.resolve();
        },
      });
    },
  };
});

vi.mock("./stockfish-leaf-evaluator.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createStockfishLeafEvaluator: () => {
      throw factoryState.constructionFailure;
    },
  };
});

import {
  AuthenticatedNodeUciEngineCloseError,
  IncompleteSameOwnerCleanupError,
  throwAfterSameOwnerCleanup,
} from "./authenticated-node-uci-engine.js";
import {
  createNodeUciTurnConstraintProvider,
  type NodeUciTurnConstraintProviderConfig,
} from "./node-turn-constraint-provider-factory.js";
import {
  createOwnedNodeUciLeafEvaluator,
  type NodeUciLeafEvaluatorConfig,
} from "./node-uci-leaf-evaluator-factory.js";

beforeEach(() => {
  factoryState.created = 0;
  factoryState.owners.splice(0);
  factoryState.constructionFailure = new Error(
    "Synthetic evaluator construction failure.",
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

function leafConfig(): NodeUciLeafEvaluatorConfig {
  return {
    kind: "stockfish",
    process: {
      executablePath: process.execPath,
      executableSha256: "b".repeat(64),
      cwd: process.cwd(),
      shutdownTimeoutMs: 100,
      runtimeContextSha256: "c".repeat(64),
    },
    client: { timeoutMs: 100 },
    engineIdentity: {
      uciName: "Pinned Engine",
      engine: "stockfish",
      version: "1.0",
      advertisedOptionsSha256: "d".repeat(64),
    },
    depth: 1,
    hashMb: 16,
    unsupportedPosition: "error",
  };
}

function providerConfig(): NodeUciTurnConstraintProviderConfig {
  return {
    process: {
      executablePath: process.execPath,
      executableSha256: "b".repeat(64),
      runtimeContextSha256: "c".repeat(64),
      shutdownTimeoutMs: 100,
    },
    client: { timeoutMs: 100 },
    policy: {
      identity: { id: "mock-policy", version: 1 },
      engineIdentity: {
        uciName: "Pinned Engine",
        engine: "mock-engine",
        version: "1.0",
      },
      advertisedOptionsSha256: "d".repeat(64),
      optionsDigest: "a".repeat(64),
      limit: { nodes: 1 },
    },
  };
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected operation to reject.");
}

describe("same-owner construction cleanup", () => {
  it("retries leaf evaluator cleanup without creating a replacement", async () => {
    const caught = await captureRejection(
      createOwnedNodeUciLeafEvaluator(leafConfig()),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    const failures = (caught as AggregateError).errors as readonly unknown[];
    expect(failures).toHaveLength(2);
    expect(failures[0]).toBe(factoryState.constructionFailure);
    expect(failures[1]).toBeInstanceOf(
      AuthenticatedNodeUciEngineCloseError,
    );
    expect(factoryState.created).toBe(1);
    expect(factoryState.owners).toEqual([{ id: 1, closeCalls: 2 }]);
  });

  it("retries provider cleanup without creating a replacement", async () => {
    const caught = await captureRejection(
      createNodeUciTurnConstraintProvider(providerConfig()),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    const failures = (caught as AggregateError).errors as readonly unknown[];
    expect(failures).toHaveLength(2);
    expect(failures[0]).toBeInstanceOf(Error);
    expect(failures[0]).toHaveProperty(
      "message",
      "Configured engine fingerprint does not match the initialized UCI engine identity.",
    );
    expect(failures[1]).toBeInstanceOf(
      AuthenticatedNodeUciEngineCloseError,
    );
    expect(factoryState.created).toBe(1);
    expect(factoryState.owners).toEqual([{ id: 1, closeCalls: 2 }]);
  });

  it("retains the owner after bounded retries and preserves every failure", async () => {
    const originalFailure = new Error("Construction failed.");
    const firstCleanupFailure = new AuthenticatedNodeUciEngineCloseError(
      "First cleanup was incomplete.",
      false,
      false,
    );
    const secondCleanupFailure = new AuthenticatedNodeUciEngineCloseError(
      "Second cleanup was incomplete.",
      true,
      false,
    );
    const thirdCleanupFailure = new AuthenticatedNodeUciEngineCloseError(
      "Explicit retry was still incomplete.",
      false,
      true,
    );
    const cleanupFailures = [
      firstCleanupFailure,
      secondCleanupFailure,
      thirdCleanupFailure,
    ];
    let closeCalls = 0;

    const caught = await captureRejection(
      throwAfterSameOwnerCleanup(
        originalFailure,
        () => {
          const failure = cleanupFailures[closeCalls];
          closeCalls += 1;
          return failure === undefined
            ? Promise.resolve()
            : Promise.reject(failure);
        },
        "Construction and cleanup failed.",
      ),
    );

    expect(closeCalls).toBe(2);
    expect(caught).toBeInstanceOf(IncompleteSameOwnerCleanupError);
    const incomplete = caught as IncompleteSameOwnerCleanupError;
    expect(incomplete.cleanupComplete).toBe(false);
    expect(incomplete.errors).toEqual([
      originalFailure,
      firstCleanupFailure,
      secondCleanupFailure,
    ]);
    const retried = await captureRejection(incomplete.retryCleanup());
    expect(closeCalls).toBe(3);
    expect(retried).toBeInstanceOf(IncompleteSameOwnerCleanupError);
    const stillIncomplete = retried as IncompleteSameOwnerCleanupError;
    expect(stillIncomplete.errors).toEqual([
      originalFailure,
      firstCleanupFailure,
      secondCleanupFailure,
      thirdCleanupFailure,
    ]);
    await expect(stillIncomplete.retryCleanup()).resolves.toBeUndefined();
    expect(closeCalls).toBe(4);
  });

  it("does not retry after typed evidence proves cleanup complete", async () => {
    const originalFailure = new Error("Construction failed.");
    const terminalCleanupFailure = new AuthenticatedNodeUciEngineCloseError(
      "Shutdown reported a failure after all resources were removed.",
      true,
      true,
    );
    let closeCalls = 0;

    const caught = await captureRejection(
      throwAfterSameOwnerCleanup(
        originalFailure,
        () => {
          closeCalls += 1;
          return Promise.reject(terminalCleanupFailure);
        },
        "Construction and cleanup failed.",
      ),
    );

    expect(closeCalls).toBe(1);
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).not.toBeInstanceOf(IncompleteSameOwnerCleanupError);
    expect((caught as AggregateError).errors).toEqual([
      originalFailure,
      terminalCleanupFailure,
    ]);
  });
});
