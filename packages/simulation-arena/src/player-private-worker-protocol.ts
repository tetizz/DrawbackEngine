import {
  assertExactKeys,
  assertPlayerPrivateGameAssignment,
  assertPlayerPrivateWorkerSearchPolicy,
  assertPositiveSafeInteger,
  protocolRecord,
  type IndexedPlayerPrivateAssignment,
  type IndexedPlayerPrivateResult,
  type PlayerPrivateWorkerSearchPolicy,
} from "./player-private-parallel-protocol.js";

export interface PlayerPrivateWorkerIdentity {
  readonly poolId: string;
  readonly workerId: number;
  readonly generation: number;
  readonly authenticationToken: string;
}

export interface PlayerPrivateWorkerInitialization
extends PlayerPrivateWorkerIdentity {
  readonly schemaVersion: 2;
  readonly kind: "player-private-worker-initialize";
  readonly policy: PlayerPrivateWorkerSearchPolicy;
  readonly maxPlies?: number;
}

export interface PlayerPrivateWorkerReady
extends PlayerPrivateWorkerIdentity {
  readonly schemaVersion: 2;
  readonly kind: "player-private-worker-ready";
  readonly evaluatorId: string;
}

export interface PlayerPrivateWorkerInitializationFailure
extends PlayerPrivateWorkerIdentity {
  readonly schemaVersion: 2;
  readonly kind: "player-private-worker-initialization-failure";
  readonly failure: {
    readonly code: "initialization-failed" | "evaluator-unavailable";
    readonly transient: boolean;
    readonly message: string;
  };
}

export interface PlayerPrivateWorkerTask
extends PlayerPrivateWorkerIdentity {
  readonly schemaVersion: 2;
  readonly kind: "player-private-worker-task";
  readonly taskId: number;
  readonly attempt: number;
  readonly assignedGames: readonly IndexedPlayerPrivateAssignment[];
}

export interface PlayerPrivateWorkerTaskResult
extends PlayerPrivateWorkerIdentity {
  readonly schemaVersion: 2;
  readonly kind: "player-private-worker-task-result";
  readonly taskId: number;
  readonly attempt: number;
  readonly games: readonly IndexedPlayerPrivateResult[];
}

export interface PlayerPrivateWorkerTaskFailure
extends PlayerPrivateWorkerIdentity {
  readonly schemaVersion: 2;
  readonly kind: "player-private-worker-task-failure";
  readonly taskId: number;
  readonly attempt: number;
  readonly failure: {
    readonly code: "task-failed" | "worker-runtime-failed";
    readonly transient: boolean;
    readonly message: string;
  };
}

export interface PlayerPrivateWorkerShutdown
extends PlayerPrivateWorkerIdentity {
  readonly schemaVersion: 2;
  readonly kind: "player-private-worker-shutdown";
}

export interface PlayerPrivateWorkerStopped
extends PlayerPrivateWorkerIdentity {
  readonly schemaVersion: 2;
  readonly kind: "player-private-worker-stopped";
}

export type PlayerPrivateWorkerParentMessage =
  | PlayerPrivateWorkerTask
  | PlayerPrivateWorkerShutdown;

export type PlayerPrivateWorkerChildMessage =
  | PlayerPrivateWorkerReady
  | PlayerPrivateWorkerInitializationFailure
  | PlayerPrivateWorkerTaskResult
  | PlayerPrivateWorkerTaskFailure
  | PlayerPrivateWorkerStopped;

export function assertPlayerPrivateWorkerInitialization(
  value: unknown,
): asserts value is PlayerPrivateWorkerInitialization {
  const initialization = protocolRecord(
    value,
    "player-private worker initialization",
  );
  const expected = [
    "schemaVersion",
    "kind",
    ...PLAYER_PRIVATE_WORKER_IDENTITY_KEYS,
    "policy",
  ];
  if (initialization["maxPlies"] !== undefined) {
    expected.push("maxPlies");
    assertPositiveSafeInteger(
      initialization["maxPlies"] as number,
      "maxPlies",
    );
  }
  assertExactKeys(
    initialization,
    expected,
    "player-private worker initialization",
  );
  if (
    initialization["schemaVersion"] !== 2
    || initialization["kind"] !== "player-private-worker-initialize"
  ) {
    throw new TypeError(
      "Player-private worker initialization schema/kind is unsupported.",
    );
  }
  assertPlayerPrivateWorkerIdentity(initialization);
  assertPlayerPrivateWorkerSearchPolicy(initialization["policy"]);
}

export function assertPlayerPrivateWorkerReady(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
  expectedEvaluatorId: string,
): asserts value is PlayerPrivateWorkerReady {
  const ready = protocolRecord(
    value,
    "player-private worker ready response",
  );
  assertExactKeys(
    ready,
    ["schemaVersion", "kind", ...PLAYER_PRIVATE_WORKER_IDENTITY_KEYS, "evaluatorId"],
    "player-private worker ready response",
  );
  if (
    ready["schemaVersion"] !== 2
    || ready["kind"] !== "player-private-worker-ready"
    || ready["evaluatorId"] !== expectedEvaluatorId
  ) {
    throw new TypeError(
      "Player-private worker ready evaluator identity is invalid.",
    );
  }
  assertPlayerPrivateWorkerIdentity(ready, expectedIdentity);
}

export function assertPlayerPrivateWorkerInitializationFailure(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
): asserts value is PlayerPrivateWorkerInitializationFailure {
  const response = protocolRecord(
    value,
    "player-private worker initialization failure",
  );
  assertExactKeys(
    response,
    ["schemaVersion", "kind", ...PLAYER_PRIVATE_WORKER_IDENTITY_KEYS, "failure"],
    "player-private worker initialization failure",
  );
  if (
    response["schemaVersion"] !== 2
    || response["kind"] !== "player-private-worker-initialization-failure"
  ) {
    throw new TypeError(
      "Player-private worker initialization failure schema/kind is unsupported.",
    );
  }
  assertPlayerPrivateWorkerIdentity(response, expectedIdentity);
  const failure = protocolRecord(
    response["failure"],
    "player-private worker initialization failure detail",
  );
  assertExactKeys(
    failure,
    ["code", "transient", "message"],
    "player-private worker initialization failure detail",
  );
  if (
    (
      failure["code"] !== "initialization-failed"
      && failure["code"] !== "evaluator-unavailable"
    )
    || (
      failure["code"] === "initialization-failed"
      && failure["transient"] !== false
    )
    || (
      failure["code"] === "evaluator-unavailable"
      && failure["transient"] !== true
    )
    || typeof failure["message"] !== "string"
    || failure["message"].trim().length === 0
    || /[\r\n]/u.test(failure["message"])
  ) {
    throw new TypeError(
      "Player-private worker initialization failure detail is invalid.",
    );
  }
}

export function assertPlayerPrivateWorkerTask(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
): asserts value is PlayerPrivateWorkerTask {
  const task = protocolRecord(value, "player-private worker task");
  assertExactKeys(
    task,
    [
      "schemaVersion",
      "kind",
      ...PLAYER_PRIVATE_WORKER_IDENTITY_KEYS,
      "taskId",
      "attempt",
      "assignedGames",
    ],
    "player-private worker task",
  );
  if (
    task["schemaVersion"] !== 2
    || task["kind"] !== "player-private-worker-task"
  ) {
    throw new TypeError(
      "Player-private worker task schema/kind is unsupported.",
    );
  }
  assertPlayerPrivateWorkerIdentity(task, expectedIdentity);
  assertNonNegativeSafeInteger(task["taskId"], "taskId");
  assertPositiveSafeInteger(task["attempt"] as number, "attempt");
  assertIndexedPlayerPrivateAssignments(task["assignedGames"]);
}

export function assertPlayerPrivateWorkerTaskFailure(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
  expectedTaskId: number,
  expectedAttempt: number,
): asserts value is PlayerPrivateWorkerTaskFailure {
  const response = protocolRecord(
    value,
    "player-private worker task failure",
  );
  assertTaskResponseEnvelope(
    response,
    "player-private-worker-task-failure",
    "failure",
    expectedIdentity,
    expectedTaskId,
    expectedAttempt,
  );
  const failure = protocolRecord(
    response["failure"],
    "player-private worker failure detail",
  );
  assertExactKeys(
    failure,
    ["code", "transient", "message"],
    "player-private worker failure detail",
  );
  if (
    (
      failure["code"] !== "task-failed"
      && failure["code"] !== "worker-runtime-failed"
    )
    || (
      failure["code"] === "task-failed"
      && failure["transient"] !== false
    )
    || (
      failure["code"] === "worker-runtime-failed"
      && failure["transient"] !== true
    )
    || typeof failure["message"] !== "string"
    || failure["message"].trim().length === 0
    || /[\r\n]/u.test(failure["message"])
  ) {
    throw new TypeError(
      "Player-private worker failure detail is invalid.",
    );
  }
}

export function assertPlayerPrivateWorkerShutdown(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
): asserts value is PlayerPrivateWorkerShutdown {
  assertIdentityOnlyMessage(
    value,
    "player-private-worker-shutdown",
    "player-private worker shutdown request",
    expectedIdentity,
  );
}

export function assertPlayerPrivateWorkerStopped(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
): asserts value is PlayerPrivateWorkerStopped {
  assertIdentityOnlyMessage(
    value,
    "player-private-worker-stopped",
    "player-private worker stopped response",
    expectedIdentity,
  );
}

export function assertPlayerPrivateWorkerTaskResultEnvelope(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
  expectedTaskId: number,
  expectedAttempt: number,
): asserts value is PlayerPrivateWorkerTaskResult {
  const response = protocolRecord(
    value,
    "player-private worker task result",
  );
  assertTaskResponseEnvelope(
    response,
    "player-private-worker-task-result",
    "games",
    expectedIdentity,
    expectedTaskId,
    expectedAttempt,
  );
  if (!Array.isArray(response["games"])) {
    throw new TypeError(
      "Player-private worker task result games must be an array.",
    );
  }
}

export const PLAYER_PRIVATE_WORKER_IDENTITY_KEYS = [
  "poolId",
  "workerId",
  "generation",
  "authenticationToken",
] as const;

function assertIdentityOnlyMessage(
  value: unknown,
  kind:
    | PlayerPrivateWorkerShutdown["kind"]
    | PlayerPrivateWorkerStopped["kind"],
  label: string,
  expectedIdentity: PlayerPrivateWorkerIdentity,
): void {
  const message = protocolRecord(value, label);
  assertExactKeys(
    message,
    ["schemaVersion", "kind", ...PLAYER_PRIVATE_WORKER_IDENTITY_KEYS],
    label,
  );
  if (
    message["schemaVersion"] !== 2
    || message["kind"] !== kind
  ) {
    throw new TypeError(`${label} schema/kind is unsupported.`);
  }
  assertPlayerPrivateWorkerIdentity(message, expectedIdentity);
}

function assertTaskResponseEnvelope(
  response: Record<string, unknown>,
  kind:
    | PlayerPrivateWorkerTaskResult["kind"]
    | PlayerPrivateWorkerTaskFailure["kind"],
  payloadKey: "games" | "failure",
  expectedIdentity: PlayerPrivateWorkerIdentity,
  expectedTaskId: number,
  expectedAttempt: number,
): void {
  assertExactKeys(
    response,
    [
      "schemaVersion",
      "kind",
      ...PLAYER_PRIVATE_WORKER_IDENTITY_KEYS,
      "taskId",
      "attempt",
      payloadKey,
    ],
    "player-private worker task response",
  );
  if (
    response["schemaVersion"] !== 2
    || response["kind"] !== kind
  ) {
    throw new TypeError(
      "Player-private worker task response schema/kind is unsupported.",
    );
  }
  assertPlayerPrivateWorkerIdentity(response, expectedIdentity);
  if (
    response["taskId"] !== expectedTaskId
    || response["attempt"] !== expectedAttempt
  ) {
    throw new RangeError(
      "Player-private worker task response correlation is invalid.",
    );
  }
}

export function assertPlayerPrivateWorkerIdentity(
  value: Record<string, unknown>,
  expected?: PlayerPrivateWorkerIdentity,
): void {
  for (const key of ["poolId", "authenticationToken"] as const) {
    if (
      typeof value[key] !== "string"
      || value[key].length < 16
      || value[key].length > 256
      || value[key].trim() !== value[key]
      || /[\r\n]/u.test(value[key])
    ) {
      throw new TypeError(
        `Player-private worker identity ${key} is invalid.`,
      );
    }
  }
  assertNonNegativeSafeInteger(value["workerId"], "workerId");
  assertNonNegativeSafeInteger(value["generation"], "generation");
  if (
    expected !== undefined
    && (
      value["poolId"] !== expected.poolId
      || value["workerId"] !== expected.workerId
      || value["generation"] !== expected.generation
      || value["authenticationToken"] !== expected.authenticationToken
    )
  ) {
    throw new TypeError(
      "Player-private worker response authentication is invalid.",
    );
  }
}

function assertIndexedPlayerPrivateAssignments(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("assignedGames must be a non-empty array.");
  }
  const indexes = new Set<number>();
  for (const raw of value) {
    const game = protocolRecord(raw, "assigned player-private game");
    assertExactKeys(
      game,
      ["gameIndex", "assignment"],
      "assigned player-private game",
    );
    const gameIndex = game["gameIndex"];
    if (
      !Number.isSafeInteger(gameIndex)
      || (gameIndex as number) < 0
      || indexes.has(gameIndex as number)
    ) {
      throw new RangeError(
        "Player-private game indexes must be unique non-negative integers.",
      );
    }
    indexes.add(gameIndex as number);
    assertPlayerPrivateGameAssignment(game["assignment"]);
  }
}

function assertNonNegativeSafeInteger(
  value: unknown,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(
      `${label} must be a non-negative safe integer.`,
    );
  }
}
