import { parentPort, workerData } from "node:worker_threads";
import {
  drawbackMaterialEvaluator,
} from "@drawbackengine/drawback-search";
import { createPlayerPrivateSearchAgent } from "./player-private-agent.js";
import {
  assertPlayerPrivateWorkerRequest,
  protocolRecord,
  type IndexedPlayerPrivateAssignment,
  type PlayerPrivateSearchPolicy,
  type PlayerPrivateWorkerRequest,
  type PlayerPrivateWorkerResponse,
} from "./player-private-parallel-protocol.js";
import {
  assertPlayerPrivateWorkerInitialization,
  assertPlayerPrivateWorkerShutdown,
  assertPlayerPrivateWorkerTask,
  type PlayerPrivateWorkerInitialization,
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

async function runAssignedGames(
  assignedGames: readonly IndexedPlayerPrivateAssignment[],
  policy: PlayerPrivateSearchPolicy,
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
        `Assignment ${String(gameIndex)} `
          + `(${assignment.whiteRuleId} vs ${assignment.blackRuleId}) `
          + `failed: ${message}`;
      const transient = findTransientParallelWorkerError(error);
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
  const games = await runAssignedGames(
    request.assignedGames,
    request.policy,
    createAgent(request.policy),
    request.maxPlies,
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "player-private-results",
    games,
  });
}

function runPersistent(
  initialization: PlayerPrivateWorkerInitialization,
  port: NonNullable<typeof parentPort>,
): void {
  assertPlayerPrivateWorkerInitialization(initialization);
  const agent = createAgent(initialization.policy);
  const identity = {
    poolId: initialization.poolId,
    workerId: initialization.workerId,
    generation: initialization.generation,
    authenticationToken: initialization.authenticationToken,
  } as const;
  const ready = Object.freeze({
    schemaVersion: 2,
    kind: "player-private-worker-ready",
    ...identity,
  } satisfies PlayerPrivateWorkerReady);
  port.postMessage(ready);

  let busy = false;
  let stopped = false;
  const onMessage = (value: unknown): void => {
    if (stopped) {
      return;
    }
    if (busy) {
      failWorker(new Error(
        "Player-private worker received overlapping parent messages.",
      ));
      return;
    }
    const record = protocolRecord(
      value,
      "player-private persistent worker message",
    );
    if (record["kind"] === "player-private-worker-shutdown") {
      assertPlayerPrivateWorkerShutdown(value, identity);
      stopped = true;
      const response = Object.freeze({
        schemaVersion: 2,
        kind: "player-private-worker-stopped",
        ...identity,
      } satisfies PlayerPrivateWorkerStopped);
      port.postMessage(response);
      port.off("message", onMessage);
      port.close();
      return;
    }
    assertPlayerPrivateWorkerTask(value, identity);
    busy = true;
    void runPersistentTask(value, initialization, agent)
      .then((response) => {
        if (!stopped) {
          port.postMessage(response);
        }
      })
      .catch((error: unknown) => {
        if (!stopped) {
          port.postMessage(
            createTaskFailure(value, identity, error),
          );
        }
      })
      .finally(() => {
        busy = false;
      });
  };
  port.on("message", onMessage);
}

async function runPersistentTask(
  task: PlayerPrivateWorkerTask,
  initialization: PlayerPrivateWorkerInitialization,
  agent: ReturnType<typeof createAgent>,
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

function createAgent(policy: PlayerPrivateSearchPolicy) {
  return createPlayerPrivateSearchAgent({
    id: policy.policyId,
    policyId: policy.policyId,
    evaluator: drawbackMaterialEvaluator,
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
    },
    temperature: {
      temperatureCp: policy.temperatureCp,
      ...(policy.topK === undefined ? {} : { topK: policy.topK }),
    },
  });
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
