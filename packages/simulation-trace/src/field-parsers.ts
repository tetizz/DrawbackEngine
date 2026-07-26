import type { SessionResult } from "@drawbackengine/chess-core";
import type { ExternalTurnConstraint } from "@drawbackengine/drawback-engine";
import type { TraceAgentSnapshot } from "./types.js";
import {
  colorAt,
  exactKeys,
  nullableNonNegativeIntegerAt,
  nullableStringAt,
  objectAt,
  stringAt,
} from "./parse-primitives.js";

export const UCI_MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][nbrq]?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function constraintAt(
  value: unknown,
  path: string,
): ExternalTurnConstraint {
  const object = objectAt(value, path);
  exactKeys(
    object,
    [
      "provider",
      "policyId",
      "positionKey",
      "requestDigest",
      "bestMoveUci",
      "engineFingerprint",
    ],
    [],
    path,
  );
  if (object.provider !== "uci-best-move") {
    throw new TypeError(`${path}.provider is invalid.`);
  }
  const requestDigest = stringAt(
    object.requestDigest,
    `${path}.requestDigest`,
  );
  if (!SHA256_PATTERN.test(requestDigest)) {
    throw new TypeError(
      `${path}.requestDigest must be a lowercase SHA-256 digest.`,
    );
  }
  const bestMoveUci = stringAt(object.bestMoveUci, `${path}.bestMoveUci`);
  if (!UCI_MOVE_PATTERN.test(bestMoveUci)) {
    throw new TypeError(`${path}.bestMoveUci must be a standard UCI move.`);
  }
  return {
    provider: "uci-best-move",
    policyId: stringAt(object.policyId, `${path}.policyId`),
    positionKey: stringAt(object.positionKey, `${path}.positionKey`),
    requestDigest,
    bestMoveUci,
    engineFingerprint: stringAt(
      object.engineFingerprint,
      `${path}.engineFingerprint`,
    ),
  };
}

export function resultAt(value: unknown, path: string): SessionResult {
  const object = objectAt(value, path);
  const kind = stringAt(object.kind, `${path}.kind`);
  if (kind === "active") {
    exactKeys(object, ["kind"], [], path);
    return { kind };
  }
  if (kind === "drawback-loss") {
    exactKeys(object, ["kind", "loss"], [], path);
    const loss = objectAt(object.loss, `${path}.loss`);
    exactKeys(loss, ["ruleId", "color", "reason"], [], `${path}.loss`);
    return {
      kind,
      loss: {
        ruleId: stringAt(loss.ruleId, `${path}.loss.ruleId`),
        color: colorAt(loss.color, `${path}.loss.color`),
        reason: stringAt(loss.reason, `${path}.loss.reason`),
      },
    };
  }
  if (kind === "king-capture") {
    exactKeys(
      object,
      ["kind", "winner", "capturedKing", "method"],
      [],
      path,
    );
    const method = stringAt(object.method, `${path}.method`);
    if (method !== "direct" && method !== "castling-en-passant") {
      throw new TypeError(`${path}.method is invalid.`);
    }
    return {
      kind,
      winner: colorAt(object.winner, `${path}.winner`),
      capturedKing: colorAt(object.capturedKing, `${path}.capturedKing`),
      method,
    };
  }
  if (kind === "no-legal-moves") {
    exactKeys(object, ["kind", "winner", "loser"], [], path);
    return {
      kind,
      winner: colorAt(object.winner, `${path}.winner`),
      loser: colorAt(object.loser, `${path}.loser`),
    };
  }
  if (kind === "checkmate") {
    exactKeys(object, ["kind", "winner"], [], path);
    return {
      kind,
      winner: colorAt(object.winner, `${path}.winner`),
    };
  }
  if (kind === "draw") {
    exactKeys(object, ["kind", "reason"], [], path);
    return {
      kind,
      reason: stringAt(object.reason, `${path}.reason`),
    };
  }
  throw new TypeError(`${path}.kind is unsupported.`);
}

export function agentAt(
  value: unknown,
  path: string,
): TraceAgentSnapshot {
  const object = objectAt(value, path);
  exactKeys(object, ["id", "style", "strength"], [], path);
  return {
    id: stringAt(object.id, `${path}.id`),
    style: nullableStringAt(object.style, `${path}.style`),
    strength: nullableNonNegativeIntegerAt(
      object.strength,
      `${path}.strength`,
    ),
  };
}
