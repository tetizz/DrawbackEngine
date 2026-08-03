import type { ChessMove } from "@drawbackengine/drawback-engine";
import type { LeafPosition } from "@drawbackengine/drawback-search";
import {
  assertExactKeys,
  protocolRecord,
} from "./player-private-parallel-protocol.js";
import {
  assertPlayerPrivateWorkerIdentity,
  PLAYER_PRIVATE_WORKER_IDENTITY_KEYS,
  type PlayerPrivateWorkerIdentity,
} from "./player-private-worker-protocol.js";

/**
 * The Node UCI leaf adapters consume these public fields. History is omitted
 * deliberately because the authenticated node-uci-leaf/v1 adapter does not
 * read it; changing that adapter requires a protocol/version update.
 */
export type PlayerPrivateUciLeafPosition = Pick<
  LeafPosition,
  | "authorityId"
  | "fen"
  | "turn"
  | "legalMoves"
  | "orthodoxCompatible"
  | "kingPassantActive"
>;

interface PlayerPrivateWorkerEvaluationEnvelope
extends PlayerPrivateWorkerIdentity {
  readonly schemaVersion: 2;
  readonly taskId: number;
  readonly attempt: number;
  readonly evaluationId: number;
}

export interface PlayerPrivateWorkerEvaluationRequest
extends PlayerPrivateWorkerEvaluationEnvelope {
  readonly kind: "player-private-worker-evaluation-request";
  readonly position: PlayerPrivateUciLeafPosition;
}

export interface PlayerPrivateWorkerEvaluationCancel
extends PlayerPrivateWorkerEvaluationEnvelope {
  readonly kind: "player-private-worker-evaluation-cancel";
}

export interface PlayerPrivateWorkerEvaluationResult
extends PlayerPrivateWorkerEvaluationEnvelope {
  readonly kind: "player-private-worker-evaluation-result";
  readonly score: number;
}

export type PlayerPrivateWorkerEvaluationFailureCode =
  | "unsupported-position"
  | "transient-evaluator"
  | "evaluation-aborted"
  | "evaluation-failed";

export interface PlayerPrivateWorkerEvaluationFailure
extends PlayerPrivateWorkerEvaluationEnvelope {
  readonly kind: "player-private-worker-evaluation-failure";
  readonly failure: {
    readonly code: PlayerPrivateWorkerEvaluationFailureCode;
    readonly message: string;
  };
}

export type PlayerPrivateWorkerEvaluationChildMessage =
  | PlayerPrivateWorkerEvaluationRequest
  | PlayerPrivateWorkerEvaluationCancel;

export type PlayerPrivateWorkerEvaluationParentMessage =
  | PlayerPrivateWorkerEvaluationResult
  | PlayerPrivateWorkerEvaluationFailure;

export function snapshotPlayerPrivateUciLeafPosition(
  position: LeafPosition,
): PlayerPrivateUciLeafPosition {
  return freezeRecursively({
    authorityId: position.authorityId,
    fen: position.fen,
    turn: position.turn,
    legalMoves: position.legalMoves.map((move) => ({ ...move })),
    orthodoxCompatible: position.orthodoxCompatible,
    kingPassantActive: position.kingPassantActive,
  });
}

export function restorePlayerPrivateUciLeafPosition(
  position: PlayerPrivateUciLeafPosition,
): LeafPosition {
  assertPlayerPrivateUciLeafPosition(position);
  return freezeRecursively({
    ...structuredClone(position),
    history: [],
  });
}

export function assertPlayerPrivateWorkerEvaluationRequest(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
  expectedTaskId: number,
  expectedAttempt: number,
): asserts value is PlayerPrivateWorkerEvaluationRequest {
  const request = protocolRecord(value, "worker evaluation request");
  assertEvaluationEnvelope(
    request,
    "player-private-worker-evaluation-request",
    "position",
    expectedIdentity,
    expectedTaskId,
    expectedAttempt,
  );
  assertPlayerPrivateUciLeafPosition(request["position"]);
}

export function assertPlayerPrivateWorkerEvaluationCancel(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
  expectedTaskId: number,
  expectedAttempt: number,
): asserts value is PlayerPrivateWorkerEvaluationCancel {
  const request = protocolRecord(value, "worker evaluation cancellation");
  assertEvaluationEnvelope(
    request,
    "player-private-worker-evaluation-cancel",
    undefined,
    expectedIdentity,
    expectedTaskId,
    expectedAttempt,
  );
}

export function assertPlayerPrivateWorkerEvaluationResult(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
  expectedTaskId: number,
  expectedAttempt: number,
): asserts value is PlayerPrivateWorkerEvaluationResult {
  const response = protocolRecord(value, "worker evaluation result");
  assertEvaluationEnvelope(
    response,
    "player-private-worker-evaluation-result",
    "score",
    expectedIdentity,
    expectedTaskId,
    expectedAttempt,
  );
  if (
    typeof response["score"] !== "number"
    || !Number.isFinite(response["score"])
  ) {
    throw new TypeError("Worker evaluation score must be finite.");
  }
}

export function assertPlayerPrivateWorkerEvaluationFailure(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
  expectedTaskId: number,
  expectedAttempt: number,
): asserts value is PlayerPrivateWorkerEvaluationFailure {
  const response = protocolRecord(value, "worker evaluation failure");
  assertEvaluationEnvelope(
    response,
    "player-private-worker-evaluation-failure",
    "failure",
    expectedIdentity,
    expectedTaskId,
    expectedAttempt,
  );
  const failure = protocolRecord(
    response["failure"],
    "worker evaluation failure detail",
  );
  assertExactKeys(
    failure,
    ["code", "message"],
    "worker evaluation failure detail",
  );
  if (
    failure["code"] !== "unsupported-position"
    && failure["code"] !== "transient-evaluator"
    && failure["code"] !== "evaluation-aborted"
    && failure["code"] !== "evaluation-failed"
  ) {
    throw new TypeError("Worker evaluation failure code is invalid.");
  }
  assertProtocolText(failure["message"], "Worker evaluation failure message");
}

export function isPlayerPrivateWorkerEvaluationParentKind(
  kind: unknown,
): boolean {
  return kind === "player-private-worker-evaluation-result"
    || kind === "player-private-worker-evaluation-failure";
}

export function isPlayerPrivateWorkerEvaluationChildKind(
  kind: unknown,
): boolean {
  return kind === "player-private-worker-evaluation-request"
    || kind === "player-private-worker-evaluation-cancel";
}

function assertEvaluationEnvelope(
  value: Record<string, unknown>,
  kind:
    | PlayerPrivateWorkerEvaluationRequest["kind"]
    | PlayerPrivateWorkerEvaluationCancel["kind"]
    | PlayerPrivateWorkerEvaluationResult["kind"]
    | PlayerPrivateWorkerEvaluationFailure["kind"],
  payloadKey: "position" | "score" | "failure" | undefined,
  expectedIdentity: PlayerPrivateWorkerIdentity,
  expectedTaskId: number,
  expectedAttempt: number,
): void {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      ...PLAYER_PRIVATE_WORKER_IDENTITY_KEYS,
      "taskId",
      "attempt",
      "evaluationId",
      ...(payloadKey === undefined ? [] : [payloadKey]),
    ],
    "worker evaluation message",
  );
  if (value["schemaVersion"] !== 2 || value["kind"] !== kind) {
    throw new TypeError("Worker evaluation schema/kind is unsupported.");
  }
  assertPlayerPrivateWorkerIdentity(value, expectedIdentity);
  if (
    value["taskId"] !== expectedTaskId
    || value["attempt"] !== expectedAttempt
  ) {
    throw new RangeError("Worker evaluation task correlation is invalid.");
  }
  assertNonNegativeSafeInteger(value["evaluationId"], "evaluationId");
}

function assertPlayerPrivateUciLeafPosition(
  value: unknown,
): asserts value is PlayerPrivateUciLeafPosition {
  const position = protocolRecord(value, "worker UCI leaf position");
  assertExactKeys(
    position,
    [
      "authorityId",
      "fen",
      "turn",
      "legalMoves",
      "orthodoxCompatible",
      "kingPassantActive",
    ],
    "worker UCI leaf position",
  );
  if (
    position["authorityId"] !== "standard-chess/v1"
    && position["authorityId"] !== "capturable-king/v1"
  ) {
    throw new TypeError("Worker UCI leaf authority is invalid.");
  }
  assertProtocolText(position["fen"], "Worker UCI leaf FEN", 512);
  if (position["turn"] !== "white" && position["turn"] !== "black") {
    throw new TypeError("Worker UCI leaf turn is invalid.");
  }
  if (
    typeof position["orthodoxCompatible"] !== "boolean"
    || typeof position["kingPassantActive"] !== "boolean"
  ) {
    throw new TypeError("Worker UCI leaf flags must be booleans.");
  }
  if (
    !Array.isArray(position["legalMoves"])
    || position["legalMoves"].length === 0
    || position["legalMoves"].length > 256
  ) {
    throw new TypeError("Worker UCI leaf moves must be a bounded non-empty array.");
  }
  for (const move of position["legalMoves"]) {
    assertChessMove(move);
  }
}

function assertChessMove(value: unknown): asserts value is ChessMove {
  const move = protocolRecord(value, "worker UCI leaf move");
  const keys = ["from", "to", "color", "piece", "san", "flags"];
  if (move["captured"] !== undefined) {
    keys.push("captured");
  }
  if (move["promotion"] !== undefined) {
    keys.push("promotion");
  }
  assertExactKeys(move, keys, "worker UCI leaf move");
  if (
    typeof move["from"] !== "string"
    || typeof move["to"] !== "string"
    || !/^[a-h][1-8]$/u.test(move["from"])
    || !/^[a-h][1-8]$/u.test(move["to"])
    || move["from"] === move["to"]
  ) {
    throw new TypeError("Worker UCI leaf move squares are invalid.");
  }
  if (move["color"] !== "white" && move["color"] !== "black") {
    throw new TypeError("Worker UCI leaf move color is invalid.");
  }
  if (!PIECE_TYPES.has(move["piece"])) {
    throw new TypeError("Worker UCI leaf moving piece is invalid.");
  }
  if (move["captured"] !== undefined && !PIECE_TYPES.has(move["captured"])) {
    throw new TypeError("Worker UCI leaf captured piece is invalid.");
  }
  if (
    move["promotion"] !== undefined
    && !PROMOTION_TYPES.has(move["promotion"])
  ) {
    throw new TypeError("Worker UCI leaf promotion is invalid.");
  }
  assertProtocolText(move["san"], "Worker UCI leaf SAN", 64);
  assertProtocolText(move["flags"], "Worker UCI leaf flags", 32);
}

function assertProtocolText(
  value: unknown,
  label: string,
  maxLength = 1_000,
): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\r\n\0]/u.test(value)
  ) {
    throw new TypeError(`${label} must be bounded, trimmed, and single-line.`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

const PIECE_TYPES = new Set<unknown>([
  "pawn",
  "knight",
  "bishop",
  "rook",
  "queen",
  "king",
]);

const PROMOTION_TYPES = new Set<unknown>([
  "knight",
  "bishop",
  "rook",
  "queen",
]);

function freezeRecursively<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const child of Object.values(value)) {
    freezeRecursively(child);
  }
  return Object.freeze(value);
}
