import type { PlayerColor } from "@drawbackengine/shared";
import type { JsonValue } from "./types.js";

type KnownTraceKey =
  | "activeSecret"
  | "agents"
  | "authorityLegalMoves"
  | "authorityId"
  | "bestMoveUci"
  | "black"
  | "capturedKing"
  | "color"
  | "drawbackInternalState"
  | "drawbackId"
  | "drawbackLegalMoves"
  | "drawbacks"
  | "engineFingerprint"
  | "evaluatorId"
  | "evaluatorCoverage"
  | "fenAfter"
  | "fenBefore"
  | "finalFen"
  | "finalPosition"
  | "forced"
  | "format"
  | "gameId"
  | "gameIndex"
  | "hiddenParameters"
  | "hypothesisPolicy"
  | "id"
  | "initialFen"
  | "initialPosition"
  | "kind"
  | "leafCacheEntries"
  | "leafCacheHistoryMode"
  | "loser"
  | "loss"
  | "method"
  | "move"
  | "maxDepth"
  | "maxNodes"
  | "ordinaryLegalMoves"
  | "parameterSeeds"
  | "plies"
  | "plyLimit"
  | "ply"
  | "policyId"
  | "positionKey"
  | "positionAfter"
  | "positionBefore"
  | "provider"
  | "publicEvaluatorConstraint"
  | "randomPolicy"
  | "reason"
  | "requestDigest"
  | "result"
  | "ruleset"
  | "ruleId"
  | "ruleTriggered"
  | "san"
  | "schemaVersion"
  | "seed"
  | "searchPolicy"
  | "secrets"
  | "stoppedAtPlyLimit"
  | "strength"
  | "style"
  | "temperatureCp"
  | "topK"
  | "uci"
  | "version"
  | "white"
  | "winner";

export type JsonObject = Record<string, unknown> & {
  readonly [Key in KnownTraceKey]?: unknown;
};

const COLORS = new Set<PlayerColor>(["white", "black"]);

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function objectAt(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as JsonObject;
}

export function exactKeys(
  object: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      throw new TypeError(`${path}.${key} is required.`);
    }
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${path}.${key} is not supported by this schema.`);
    }
  }
}

export function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

export function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be a boolean.`);
  }
  return value;
}

export function safeIntegerAt(
  value: unknown,
  path: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(
      `${path} must be a safe integer of at least ${String(minimum)}.`,
    );
  }
  return Number(value);
}

export function nullableStringAt(
  value: unknown,
  path: string,
): string | null {
  return value === null ? null : stringAt(value, path);
}

export function nullableNonNegativeIntegerAt(
  value: unknown,
  path: string,
): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(
      `${path} must be a non-negative safe integer or null.`,
    );
  }
  return Number(value);
}

export function colorAt(value: unknown, path: string): PlayerColor {
  if (!COLORS.has(value as PlayerColor)) {
    throw new TypeError(`${path} must be white or black.`);
  }
  return value as PlayerColor;
}

export function jsonValueAt(
  value: unknown,
  path: string,
  depth = 0,
): JsonValue {
  if (depth > 64) {
    throw new TypeError(`${path} exceeds the maximum JSON nesting depth.`);
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return typeof value === "number" && Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return Array.from(value, (entry, index) =>
      jsonValueAt(entry, `${path}[${String(index)}]`, depth + 1));
  }
  if (typeof value === "object") {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    const stringKeys = ownKeys.filter(
      (key): key is string => typeof key === "string",
    );
    if (stringKeys.length !== ownKeys.length) {
      throw new TypeError(`${path} must not contain symbol keys.`);
    }
    const entries: [string, JsonValue][] = [];
    for (const key of stringKeys.sort(compareOrdinal)) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) {
        throw new TypeError(
          `${path}.${key} must be an enumerable JSON data property.`,
        );
      }
      entries.push([
        key,
        jsonValueAt(descriptor.value, `${path}.${key}`, depth + 1),
      ]);
    }
    return Object.fromEntries(entries);
  }
  throw new TypeError(`${path} must contain only JSON-safe values.`);
}

export function stringListAt(
  value: unknown,
  path: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array.`);
  }
  return value.map((entry, index) =>
    stringAt(entry, `${path}[${String(index)}]`));
}
