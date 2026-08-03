import { parentPort, workerData } from "node:worker_threads";
import {
  drawbackMaterialEvaluator,
  type DrawbackLeafEvaluator,
} from "@drawbackengine/drawback-search";
import {
  UciTimeoutError,
  UciTransportError,
} from "@drawbackengine/chess-evaluator";
import {
  createPlayerPrivateSearchAgent,
  type PlayerPrivateSimulationAgent,
} from "./player-private-agent.js";
import {
  assertPlayerPrivateWorkerRequest,
  protocolRecord,
  type IndexedPlayerPrivateAssignment,
  type PlayerPrivateWorkerSearchPolicy,
  type PlayerPrivateWorkerRequest,
  type PlayerPrivateWorkerResponse,
} from "./player-private-parallel-protocol.js";
import {
  assertPlayerPrivateWorkerInitialization,
  assertPlayerPrivateWorkerShutdown,
  assertPlayerPrivateWorkerTask,
  type PlayerPrivateWorkerInitialization,
  type PlayerPrivateWorkerInitializationFailure,
  type PlayerPrivateWorkerReady,
  type PlayerPrivateWorkerStopped,
  type PlayerPrivateWorkerTask,
  type PlayerPrivateWorkerTaskFailure,
  type PlayerPrivateWorkerTaskResult,
} from "./player-private-worker-protocol.js";
import {
  resolvePlayerPrivateRule,
} from "./player-private-catalog.js";
import {
  auditedUniformOpponentHypotheses,
  simulatePlayerPrivateGame,
  unrestrictedOpponentHypotheses,
} from "./player-private-simulation.js";
import {
  TransientParallelWorkerError,
  findTransientParallelWorkerError,
  isTransientParallelWorkerError,
} from "./worker-retry.js";
import {
  PlayerPrivateRemoteLeafEvaluator,
} from "./player-private-remote-leaf-evaluator.js";

async function runAssignedGames(
  assignedGames: readonly IndexedPlayerPrivateAssignment[],
  policy: PlayerPrivateWorkerSearchPolicy,
  agent: ReturnType<typeof createAgent>,
  maxPlies?: number,
): Promise<PlayerPrivateWorkerResponse["games"]> {
  const games: PlayerPrivateWorkerResponse["games"][number][] = [];
  for (const { gameIndex, assignment } of assignedGames) {
    try {
      games.push({
        gameIndex,
        result: await simulatePlayerPrivateGame({
          seed: assignment.seed,
          parameterSeeds: assignment.parameterSeeds,
          rules: {
            white: resolvePlayerPrivateRule(assignment.whiteRuleId),
            black: resolvePlayerPrivateRule(assignment.blackRuleId),
          },
          whiteAgent: agent,
          blackAgent: agent,
          opponentHypotheses:
            policy.opponentHypotheses.kind === "audited-uniform"
              ? auditedUniformOpponentHypotheses
              : unrestrictedOpponentHypotheses,
          ...(assignment.initialFen === undefined
            ? {}
            : { fen: assignment.initialFen }),
          ...(maxPlies === undefined ? {} : { maxPlies }),
        }),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown game failure.";
      const contextualMessage =
        `Player-private assignment ${String(gameIndex)} failed: ${message}`;
      const transient = findRetryableEvaluatorFailure(error);
      if (transient !== undefined) {
        throw new TransientParallelWorkerError(
          transient.code,
          contextualMessage,
          { cause: error },
        );
      }
      throw new Error(
        contextualMessage,
        { cause: error },
      );
    }
  }
  return Object.freeze(games);
}

async function runLegacy(
  request: PlayerPrivateWorkerRequest,
): Promise<PlayerPrivateWorkerResponse> {
  assertPlayerPrivateWorkerRequest(request);
  const runtime = createWorkerRuntime(request.policy);
  try {
    const games = await runAssignedGames(
      request.assignedGames,
      request.policy,
      runtime.agent,
      request.maxPlies,
    );
    return Object.freeze({
      schemaVersion: 1,
      kind: "player-private-results",
      games,
    });
  } finally {
    await runtime.close();
  }
}

function runPersistent(
  initialization: PlayerPrivateWorkerInitialization,
  port: NonNullable<typeof parentPort>,
): void {
  assertPlayerPrivateWorkerInitialization(initialization);
  const identity = {
    poolId: initialization.poolId,
    workerId: initialization.workerId,
    generation: initialization.generation,
    authenticationToken: initialization.authenticationToken,
  } as const;
  let runtime: WorkerRuntime;
  try {
    runtime = createWorkerRuntime(
      initialization.policy,
      port,
      identity,
    );
  } catch (error: unknown) {
    const transient = findRetryableEvaluatorFailure(error) !== undefined;
    const failure = Object.freeze({
      schemaVersion: 2,
      kind: "player-private-worker-initialization-failure",
      ...identity,
      failure: Object.freeze({
        code: transient
          ? "evaluator-unavailable"
          : "initialization-failed",
        transient,
        message: initializationFailureMessage(error, transient),
      }),
    } satisfies PlayerPrivateWorkerInitializationFailure);
    port.postMessage(failure);
    port.close();
    return;
  }
  const ready = Object.freeze({
    schemaVersion: 2,
    kind: "player-private-worker-ready",
    ...identity,
    evaluatorId: runtime.evaluator.id,
  } satisfies PlayerPrivateWorkerReady);
  port.postMessage(ready);

  let busy = false;
  let stopped = false;
  let activeTask: Promise<void> | undefined;
  const finishShutdown = (
    terminalFailure?: Error,
  ): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    port.off("message", onMessage);
    runtime.abort();
    const pending = activeTask ?? Promise.resolve();
    void pending
      .then(() => runtime.close())
      .then(() => {
        if (terminalFailure !== undefined) {
          port.close();
          failWorker(terminalFailure);
          return;
        }
        postStopped(port, identity);
      })
      .catch((error: unknown) => {
        port.close();
        failWorker(
          terminalFailure === undefined
            ? new Error(
                "Player-private worker evaluator shutdown failed.",
                { cause: error },
              )
            : new AggregateError(
                [terminalFailure, error],
                "Player-private worker failed and evaluator cleanup was incomplete.",
              ),
        );
      });
  };
  const onMessage = (value: unknown): void => {
    if (stopped) {
      return;
    }
    try {
      const record = protocolRecord(
        value,
        "player-private persistent worker message",
      );
      if (runtime.handleParentMessage(value)) {
        return;
      }
      if (record["kind"] === "player-private-worker-shutdown") {
        assertPlayerPrivateWorkerShutdown(value, identity);
        finishShutdown();
        return;
      }
      if (busy) {
        finishShutdown(new Error(
          "Player-private worker received overlapping parent messages.",
        ));
        return;
      }
      assertPlayerPrivateWorkerTask(value, identity);
      busy = true;
      runtime.beginTask(value);
      const task = runPersistentTask(
        value,
        initialization,
        runtime.agent,
      )
        .then((response) => {
          if (!stopped) {
            port.postMessage(response);
          }
        })
        .catch((error: unknown) => {
          if (!stopped) {
            const failure = createTaskFailure(value, identity, error);
            port.postMessage(failure);
          }
        })
        .finally(() => {
          runtime.endTask(value);
          busy = false;
        });
      activeTask = task;
    } catch (error: unknown) {
      finishShutdown(
        error instanceof Error
          ? error
          : new Error("Player-private worker protocol validation failed."),
      );
    }
  };
  port.on("message", onMessage);
}

function postStopped(
  port: NonNullable<typeof parentPort>,
  identity: {
    readonly poolId: string;
    readonly workerId: number;
    readonly generation: number;
    readonly authenticationToken: string;
  },
): void {
  const response = Object.freeze({
    schemaVersion: 2,
    kind: "player-private-worker-stopped",
    ...identity,
  } satisfies PlayerPrivateWorkerStopped);
  port.postMessage(response);
  port.close();
}

async function runPersistentTask(
  task: PlayerPrivateWorkerTask,
  initialization: PlayerPrivateWorkerInitialization,
  agent: PlayerPrivateSimulationAgent,
): Promise<PlayerPrivateWorkerTaskResult> {
  const games = await runAssignedGames(
    task.assignedGames,
    initialization.policy,
    agent,
    initialization.maxPlies,
  );
  return Object.freeze({
    schemaVersion: 2,
    kind: "player-private-worker-task-result",
    poolId: task.poolId,
    workerId: task.workerId,
    generation: task.generation,
    authenticationToken: task.authenticationToken,
    taskId: task.taskId,
    attempt: task.attempt,
    games,
  });
}

function createTaskFailure(
  task: PlayerPrivateWorkerTask,
  identity: {
    readonly poolId: string;
    readonly workerId: number;
    readonly generation: number;
    readonly authenticationToken: string;
  },
  error: unknown,
): PlayerPrivateWorkerTaskFailure {
  const transient = isTransientParallelWorkerError(error);
  return Object.freeze({
    schemaVersion: 2,
    kind: "player-private-worker-task-failure",
    ...identity,
    taskId: task.taskId,
    attempt: task.attempt,
    failure: Object.freeze({
      code: transient ? "worker-runtime-failed" : "task-failed",
      transient,
      message: sanitizeFailureMessage(error),
    }),
  });
}

function sanitizeFailureMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : "Unknown worker task failure.";
  const singleLine = raw.replace(/[\r\n]+/gu, " ").trim();
  return singleLine.length === 0
    ? "Unknown worker task failure."
    : singleLine.slice(0, 1_000);
}

interface WorkerRuntime {
  readonly evaluator: DrawbackLeafEvaluator;
  readonly agent: PlayerPrivateSimulationAgent;
  beginTask(task: PlayerPrivateWorkerTask): void;
  endTask(task: PlayerPrivateWorkerTask): void;
  handleParentMessage(value: unknown): boolean;
  abort(): void;
  close(): Promise<void>;
}

function createWorkerRuntime(
  policy: PlayerPrivateWorkerSearchPolicy,
  port?: NonNullable<typeof parentPort>,
  identity?: {
    readonly poolId: string;
    readonly workerId: number;
    readonly generation: number;
    readonly authenticationToken: string;
  },
): WorkerRuntime {
  const controller = new AbortController();
  if (policy.evaluator.kind === "material") {
    return Object.freeze({
      evaluator: drawbackMaterialEvaluator,
      agent: createAgent(
        policy,
        drawbackMaterialEvaluator,
        controller.signal,
      ),
      beginTask: () => undefined,
      endTask: () => undefined,
      handleParentMessage: () => false,
      abort: () => {
        controller.abort();
      },
      close: () => Promise.resolve(),
    });
  }
  if (port === undefined || identity === undefined) {
    throw new Error(
      "Node UCI evaluation requires a persistent parent-owned evaluator.",
    );
  }
  const evaluator = new PlayerPrivateRemoteLeafEvaluator(
    policy.evaluator.evaluatorId,
    identity,
    port,
  );
  return Object.freeze({
    evaluator,
    agent: createAgent(policy, evaluator, controller.signal),
    beginTask: (task: PlayerPrivateWorkerTask) => {
      evaluator.beginTask(task);
    },
    endTask: (task: PlayerPrivateWorkerTask) => {
      evaluator.endTask(task);
    },
    handleParentMessage: (value: unknown) => evaluator.handleParentMessage(value),
    abort: () => {
      controller.abort();
    },
    close: () => {
      evaluator.close();
      return Promise.resolve();
    },
  });
}

function createAgent(
  policy: PlayerPrivateWorkerSearchPolicy,
  evaluator: DrawbackLeafEvaluator,
  signal: AbortSignal,
): PlayerPrivateSimulationAgent {
  return createPlayerPrivateSearchAgent({
    id: policy.policyId,
    policyId: policy.policyId,
    evaluator,
    opponentAggregation:
      policy.opponentAggregation ?? "worst-case",
    limits: {
      maxDepth: policy.maxDepth,
      maxNodes: policy.maxNodes,
      ...(policy.leafCacheEntries === undefined
        ? {}
        : { leafCacheEntries: policy.leafCacheEntries }),
      ...(policy.leafCacheHistoryMode === undefined
        ? {}
        : { leafCacheHistoryMode: policy.leafCacheHistoryMode }),
      signal,
    },
    temperature: {
      temperatureCp: policy.temperatureCp,
      ...(policy.topK === undefined ? {} : { topK: policy.topK }),
    },
  });
}

function findRetryableEvaluatorFailure(
  value: unknown,
): TransientParallelWorkerError | undefined {
  const existing = findTransientParallelWorkerError(value);
  if (existing !== undefined) {
    return existing;
  }
  const seen = new Set<unknown>();
  let current = value;
  while (current instanceof Error && !seen.has(current)) {
    if (
      current instanceof UciTimeoutError
      || current instanceof UciTransportError
    ) {
      return new TransientParallelWorkerError(
        "worker-reported-transient",
        "The authenticated UCI evaluator became unavailable.",
        { cause: value },
      );
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

function initializationFailureMessage(
  error: unknown,
  transient: boolean,
): string {
  if (transient) {
    return "The authenticated UCI evaluator process was unavailable.";
  }
  return "Player-private evaluator initialization failed.";
}

function failWorker(error: Error): void {
  process.nextTick(() => {
    throw error;
  });
}

if (parentPort === null) {
  throw new Error("Player-private simulation worker requires a parent port.");
}

try {
  const data = protocolRecord(workerData, "player-private worker data");
  if (data["kind"] === "player-private-worker-initialize") {
    runPersistent(
      workerData as PlayerPrivateWorkerInitialization,
      parentPort,
    );
  } else {
    parentPort.postMessage(
      await runLegacy(workerData as PlayerPrivateWorkerRequest),
    );
  }
} catch (error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unknown worker failure.";
  throw new Error(
    `Player-private simulation worker failed: ${message}`,
    { cause: error },
  );
}
