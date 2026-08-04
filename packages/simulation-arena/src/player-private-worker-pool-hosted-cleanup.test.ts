import { afterEach, describe, expect, it, vi } from "vitest";

const hostedState = vi.hoisted(() => ({
  evaluatorCreations: 0,
  evaluatorCloseCalls: 0,
  evaluatorCreationGate: undefined as Promise<void> | undefined,
  evaluatorControlSignal: undefined as AbortSignal | undefined,
  evaluatorId: "",
  deferredEvaluatorCreation: 0,
  terminalCleanup: false,
  workerLaunches: 0,
  workerTerminateCalls: 0,
}));

vi.mock("@drawbackengine/chess-evaluator", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const CloseError = actual["NodeUciLeafEvaluatorCloseError"] as new (
    message: string,
    privateResourcesRemoved: boolean,
    processTerminated: boolean,
  ) => Error;
  return {
    ...actual,
    createOwnedNodeUciLeafEvaluator: async (
      _config: unknown,
      control: { readonly signal?: AbortSignal } = {},
    ) => {
      hostedState.evaluatorCreations += 1;
      hostedState.evaluatorControlSignal = control.signal;
      if (
        hostedState.evaluatorCreations
          === hostedState.deferredEvaluatorCreation
      ) {
        await abortableGate(
          hostedState.evaluatorCreationGate,
          control.signal,
        );
      }
      return {
        id: hostedState.evaluatorId,
        evaluate: () => Promise.resolve(0),
        close: () => {
          hostedState.evaluatorCloseCalls += 1;
          if (hostedState.terminalCleanup) {
            return Promise.reject(new CloseError(
              "Hosted evaluator cleanup completed abnormally.",
              true,
              true,
            ));
          }
          return hostedState.evaluatorCloseCalls <= 2
            ? Promise.reject(new CloseError(
                "Hosted evaluator cleanup remains unproven.",
                true,
                false,
              ))
            : Promise.resolve();
        },
      };
    },
  };
});

function abortableGate(
  gate: Promise<void> | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (gate === undefined) {
    return Promise.resolve();
  }
  if (signal === undefined) {
    return gate;
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Test startup aborted.", "AbortError"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    void gate.then(
      () => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve();
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error instanceof Error
            ? error
            : new Error("Test evaluator gate failed.", { cause: error }));
        }
      },
    );
  });
}

import {
  deriveNodeUciLeafEvaluatorId,
  IncompleteSameOwnerCleanupError,
  type NodeStockfishLeafEvaluatorConfig,
} from "@drawbackengine/chess-evaluator";
import type {
  PlayerPrivateSearchPolicy,
} from "./player-private-parallel-protocol.js";
import {
  createPlayerPrivateWorkerPool,
} from "./player-private-worker-pool.js";
import {
  createNodePlayerPrivateWorker,
} from "./player-private-worker-transport.js";

const config: NodeStockfishLeafEvaluatorConfig = {
  kind: "stockfish",
  process: {
    executablePath: process.execPath,
    executableSha256: "a".repeat(64),
    cwd: process.cwd(),
    shutdownTimeoutMs: 100,
    runtimeContextSha256: "b".repeat(64),
  },
  client: { timeoutMs: 100 },
  engineIdentity: {
    uciName: "Hosted Cleanup Test",
    engine: "stockfish",
    version: "test",
    advertisedOptionsSha256: "c".repeat(64),
  },
  depth: 1,
  hashMb: 16,
  unsupportedPosition: "error",
};

const evaluatorId = deriveNodeUciLeafEvaluatorId(config);
hostedState.evaluatorId = evaluatorId;

const policy: PlayerPrivateSearchPolicy = {
  policyId: "hosted-cleanup-test",
  maxDepth: 1,
  maxNodes: 2_000,
  temperatureCp: 1,
  evaluator: {
    kind: "node-uci-leaf",
    version: 1,
    evaluatorId,
    config,
  },
  opponentHypotheses: {
    kind: "unrestricted-baseline",
    version: 1,
  },
};

afterEach(() => {
  hostedState.evaluatorCreations = 0;
  hostedState.evaluatorCloseCalls = 0;
  hostedState.evaluatorCreationGate = undefined;
  hostedState.evaluatorControlSignal = undefined;
  hostedState.evaluatorId = evaluatorId;
  hostedState.deferredEvaluatorCreation = 0;
  hostedState.terminalCleanup = false;
  hostedState.workerLaunches = 0;
  hostedState.workerTerminateCalls = 0;
});

describe("pre-slot hosted evaluator cleanup", () => {
  it("cancels authenticated evaluator startup before launching a worker", async () => {
    hostedState.deferredEvaluatorCreation = 1;
    hostedState.evaluatorCreationGate = new Promise<void>(() => undefined);
    const controller = new AbortController();
    const reason = new Error("Stop worker-pool startup.");
    const started = createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      attempts: 1,
      signal: controller.signal,
      workerFactory: () => {
        hostedState.workerLaunches += 1;
        throw new Error("Worker must not launch after startup cancellation.");
      },
    });

    await vi.waitFor(() => {
      expect(hostedState.evaluatorControlSignal).toBe(controller.signal);
    });
    controller.abort(reason);

    await expect(started).rejects.toBe(reason);
    expect(hostedState.evaluatorCreations).toBe(1);
    expect(hostedState.workerLaunches).toBe(0);
    expect(hostedState.evaluatorCloseCalls).toBe(0);
  });

  it("retains the same evaluator when worker launch cleanup stays unproven", async () => {
    const failure = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      attempts: 1,
      workerFactory: () => {
        hostedState.workerLaunches += 1;
        throw new Error("Synthetic worker launch failure.");
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IncompleteSameOwnerCleanupError);
    expect(hostedState.evaluatorCreations).toBe(1);
    expect(hostedState.workerLaunches).toBe(1);
    expect(hostedState.evaluatorCloseCalls).toBe(2);
    if (!(failure instanceof IncompleteSameOwnerCleanupError)) {
      throw new Error("Expected retained hosted evaluator ownership.");
    }

    await expect(failure.retryCleanup()).resolves.toBeUndefined();
    expect(hostedState.evaluatorCreations).toBe(1);
    expect(hostedState.workerLaunches).toBe(1);
    expect(hostedState.evaluatorCloseCalls).toBe(3);
  });

  it("does not retry after hosted evaluator cleanup is proven complete", async () => {
    hostedState.terminalCleanup = true;
    const failure = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      attempts: 1,
      workerFactory: () => {
        hostedState.workerLaunches += 1;
        throw new Error("Synthetic worker launch failure.");
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).not.toBeInstanceOf(IncompleteSameOwnerCleanupError);
    expect(hostedState.evaluatorCreations).toBe(1);
    expect(hostedState.workerLaunches).toBe(1);
    expect(hostedState.evaluatorCloseCalls).toBe(1);
  });

  it("retains exact provisional resources when worker subscription throws", async () => {
    const failure = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      attempts: 1,
      workerFactory: () => {
        hostedState.workerLaunches += 1;
        return {
          postMessage: () => undefined,
          subscribe: () => {
            throw new Error("Synthetic worker subscription failure.");
          },
          terminate: () => {
            hostedState.workerTerminateCalls += 1;
            return Promise.resolve(0);
          },
        };
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IncompleteSameOwnerCleanupError);
    expect(hostedState.evaluatorCreations).toBe(1);
    expect(hostedState.workerLaunches).toBe(1);
    expect(hostedState.workerTerminateCalls).toBe(1);
    expect(hostedState.evaluatorCloseCalls).toBe(2);
    if (!(failure instanceof IncompleteSameOwnerCleanupError)) {
      throw new Error("Expected retained provisional resource ownership.");
    }

    await expect(failure.retryCleanup()).resolves.toBeUndefined();
    expect(hostedState.evaluatorCreations).toBe(1);
    expect(hostedState.workerLaunches).toBe(1);
    expect(hostedState.workerTerminateCalls).toBe(1);
    expect(hostedState.evaluatorCloseCalls).toBe(3);
  });

  it("retains the exact provisional transport when its termination is unproven", async () => {
    hostedState.terminalCleanup = true;
    const failure = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      attempts: 1,
      workerFactory: () => {
        hostedState.workerLaunches += 1;
        return {
          postMessage: () => undefined,
          subscribe: () => {
            throw new Error("Synthetic worker subscription failure.");
          },
          terminate: () => {
            hostedState.workerTerminateCalls += 1;
            return hostedState.workerTerminateCalls <= 2
              ? Promise.reject(new Error("Transport remains active."))
              : Promise.resolve(0);
          },
        };
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IncompleteSameOwnerCleanupError);
    expect(hostedState.evaluatorCreations).toBe(1);
    expect(hostedState.workerLaunches).toBe(1);
    expect(hostedState.workerTerminateCalls).toBe(2);
    expect(hostedState.evaluatorCloseCalls).toBe(1);
    if (!(failure instanceof IncompleteSameOwnerCleanupError)) {
      throw new Error("Expected retained provisional transport ownership.");
    }

    await expect(failure.retryCleanup()).resolves.toBeUndefined();
    expect(hostedState.evaluatorCreations).toBe(1);
    expect(hostedState.workerLaunches).toBe(1);
    expect(hostedState.workerTerminateCalls).toBe(3);
    expect(hostedState.evaluatorCloseCalls).toBe(1);
  });

  it("does not launch a replacement after close races evaluator creation", async () => {
    hostedState.terminalCleanup = true;
    hostedState.deferredEvaluatorCreation = 2;
    let releaseEvaluator: (() => void) | undefined;
    hostedState.evaluatorCreationGate = new Promise<void>((resolve) => {
      releaseEvaluator = resolve;
    });
    let firstTaskStopped = false;
    const pool = await createPlayerPrivateWorkerPool({
      workers: 1,
      policy,
      maxPlies: 1,
      attempts: 2,
      workerFactory: (request) => {
        hostedState.workerLaunches += 1;
        const transport = createNodePlayerPrivateWorker(request);
        return {
          postMessage: (value: unknown) => {
            const kind = typeof value === "object" && value !== null
              ? (value as Record<string, unknown>)["kind"]
              : undefined;
            if (
              request.workerData.generation === 0
              && kind === "player-private-worker-task"
              && !firstTaskStopped
            ) {
              firstTaskStopped = true;
              void transport.terminate();
              return;
            }
            transport.postMessage(value);
          },
          subscribe: (handlers) => transport.subscribe(handlers),
          terminate: () => transport.terminate(),
        };
      },
    });
    const batch = pool.runBatch([{
      gameIndex: 0,
      assignment: {
        seed: 71_001,
        parameterSeeds: { white: 72_001, black: 72_002 },
        whiteRuleId: "vegan",
        blackRuleId: "checkers",
      },
    }]);
    await vi.waitFor(() => {
      expect(hostedState.evaluatorCreations).toBe(2);
    });

    await expect(pool.close()).resolves.toBeUndefined();
    releaseEvaluator?.();
    const failure = await batch.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(errorMessages(failure)).toContain(
      "Player-private worker pool closed during evaluator creation.",
    );
    expect(hostedState.workerLaunches).toBe(1);
    expect(hostedState.evaluatorCreations).toBe(2);
    expect(hostedState.evaluatorCloseCalls).toBe(2);
    expect(pool.diagnostics().activeWorkers).toBe(0);
  }, 30_000);
});

function errorMessages(value: unknown): readonly string[] {
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause !== undefined) {
        pending.push(current.cause);
      }
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors as readonly unknown[]);
    }
  }
  return messages;
}
