import {
  CapturableKingPosition,
  type CapturableKingPositionSnapshot,
} from "@drawbackengine/chess-core";
import {
  isAuditedCapturableKingRuleId,
} from "@drawbackengine/drawback-engine";
import { UCI_MOVE_PATTERN } from "./field-parsers.js";
import {
  booleanAt,
  colorAt,
  exactKeys,
  jsonValueAt,
  nullableNonNegativeIntegerAt,
  objectAt,
  safeIntegerAt,
  stringAt,
  stringListAt,
} from "./parse-primitives.js";
import type {
  PlayerPrivateSimulationTracePly,
  PlayerPrivateSimulationTraceRecord,
  PlayerPrivateRulesetVersion,
  TracePlayerPrivateAgent,
  TracePlayerPrivateSearchPolicy,
  TraceRuleSecret,
} from "./player-private-types.js";

const PLAYER_PRIVATE_RULESET_V1_IDS: ReadonlySet<string> = new Set([
  "vegan",
  "lame-duck",
  "checkers",
  "truant",
  "spice-of-life",
  "femme-fatale",
  "nurturer",
  "triple-play",
  "you-best-not-miss",
  "irresistible",
]);

export function playerPrivateSecretAt(
  value: unknown,
  path: string,
  rulesetVersion: PlayerPrivateRulesetVersion,
): TraceRuleSecret {
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["drawbackId", "hiddenParameters", "drawbackInternalState"],
    [],
    path,
  );
  const drawbackId = stringAt(object.drawbackId, `${path}.drawbackId`);
  if (
    !isAuditedCapturableKingRuleId(drawbackId)
    || (
      rulesetVersion === 1
      && !PLAYER_PRIVATE_RULESET_V1_IDS.has(drawbackId)
    )
  ) {
    throw new TypeError(
      `${path}.drawbackId is outside capturable ruleset version ${String(rulesetVersion)}.`,
    );
  }
  return {
    drawbackId,
    hiddenParameters: jsonValueAt(
      object.hiddenParameters,
      `${path}.hiddenParameters`,
    ),
    drawbackInternalState: jsonValueAt(
      object.drawbackInternalState,
      `${path}.drawbackInternalState`,
    ),
  };
}

export function playerPrivateAgentAt(
  value: unknown,
  path: string,
): TracePlayerPrivateAgent {
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["id", "style", "strength", "searchPolicy"],
    [],
    path,
  );
  if (object.style !== "drawback-search") {
    throw new TypeError(`${path}.style must be drawback-search.`);
  }
  return {
    id: singleLineIdentifierAt(object.id, `${path}.id`),
    style: "drawback-search",
    strength: nullableNonNegativeIntegerAt(
      object.strength,
      `${path}.strength`,
    ),
    searchPolicy: searchPolicyAt(
      object.searchPolicy,
      `${path}.searchPolicy`,
    ),
  };
}

export function playerPrivateSnapshotAt(
  value: unknown,
  path: string,
): CapturableKingPositionSnapshot {
  try {
    return CapturableKingPosition.fromSnapshot(value).snapshot();
  } catch (error: unknown) {
    throw new TypeError(
      `${path} is not a valid capturable-king authority snapshot: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function playerPrivatePlyAt(
  value: unknown,
  index: number,
  path: string,
  rulesetVersion: PlayerPrivateRulesetVersion,
): PlayerPrivateSimulationTracePly {
  const object = objectAt(value, path);
  exactKeys(
    object,
    [
      "ply",
      "color",
      "positionBefore",
      "positionAfter",
      "move",
      "authorityLegalMoves",
      "drawbackLegalMoves",
      "ruleTriggered",
      "forced",
      "activeSecret",
    ],
    [],
    path,
  );
  const ply = safeIntegerAt(object.ply, `${path}.ply`);
  if (ply !== index) {
    throw new TypeError(`${path}.ply must equal its zero-based array index.`);
  }
  const color = colorAt(object.color, `${path}.color`);
  const positionBefore = playerPrivateSnapshotAt(
    object.positionBefore,
    `${path}.positionBefore`,
  );
  const fenTurn = positionBefore.fen.split(" ")[1];
  if (
    (color === "white" && fenTurn !== "w")
    || (color === "black" && fenTurn !== "b")
  ) {
    throw new TypeError(`${path}.color must match the authority position.`);
  }
  const moveObject = objectAt(object.move, `${path}.move`);
  exactKeys(moveObject, ["uci", "san"], [], `${path}.move`);
  const uci = stringAt(moveObject.uci, `${path}.move.uci`);
  if (!UCI_MOVE_PATTERN.test(uci)) {
    throw new TypeError(`${path}.move.uci must be a standard UCI move.`);
  }
  const authorityLegalMoves = moveListAt(
    object.authorityLegalMoves,
    `${path}.authorityLegalMoves`,
  );
  const drawbackLegalMoves = moveListAt(
    object.drawbackLegalMoves,
    `${path}.drawbackLegalMoves`,
  );
  const authoritySet = new Set(authorityLegalMoves);
  if (drawbackLegalMoves.some((move) => !authoritySet.has(move))) {
    throw new TypeError(
      `${path}.drawbackLegalMoves must be a subset of authorityLegalMoves.`,
    );
  }
  if (!drawbackLegalMoves.includes(uci)) {
    throw new TypeError(`${path}.move.uci must be drawback-legal.`);
  }
  const ruleTriggered = booleanAt(
    object.ruleTriggered,
    `${path}.ruleTriggered`,
  );
  if (
    ruleTriggered
    !== (authorityLegalMoves.length !== drawbackLegalMoves.length)
  ) {
    throw new TypeError(`${path}.ruleTriggered does not match the legal masks.`);
  }
  const forced = booleanAt(object.forced, `${path}.forced`);
  if (forced !== (drawbackLegalMoves.length === 1)) {
    throw new TypeError(`${path}.forced does not match the legal mask.`);
  }
  return {
    ply,
    color,
    positionBefore,
    positionAfter: playerPrivateSnapshotAt(
      object.positionAfter,
      `${path}.positionAfter`,
    ),
    move: {
      uci,
      san: stringAt(moveObject.san, `${path}.move.san`),
    },
    authorityLegalMoves,
    drawbackLegalMoves,
    ruleTriggered,
    forced,
    activeSecret: playerPrivateSecretAt(
      object.activeSecret,
      `${path}.activeSecret`,
      rulesetVersion,
    ),
  };
}

export function playerPrivateSecretsAt(
  value: unknown,
  path: string,
  rulesetVersion: PlayerPrivateRulesetVersion,
): PlayerPrivateSimulationTraceRecord["secrets"] {
  const object = objectAt(value, path);
  exactKeys(object, ["initial", "final"], [], path);
  return {
    initial: colorsAt(
      object["initial"],
      `${path}.initial`,
      rulesetVersion,
    ),
    final: colorsAt(
      object["final"],
      `${path}.final`,
      rulesetVersion,
    ),
  };
}

export function playerPrivateParameterSeedsAt(
  value: unknown,
  path: string,
): PlayerPrivateSimulationTraceRecord["parameterSeeds"] {
  const object = objectAt(value, path);
  exactKeys(object, ["white", "black"], [], path);
  const white = unsignedSeedAt(object.white, `${path}.white`);
  const black = unsignedSeedAt(object.black, `${path}.black`);
  return { white, black };
}

export function requireLiteralPolicy(
  value: unknown,
  path: string,
  kind: string,
): void {
  const object = objectAt(value, path);
  exactKeys(object, ["kind", "version"], [], path);
  if (object.kind !== kind || object.version !== 1) {
    throw new TypeError(`${path} is unsupported.`);
  }
}

function searchPolicyAt(
  value: unknown,
  path: string,
): TracePlayerPrivateSearchPolicy {
  const object = objectAt(value, path);
  exactKeys(
    object,
    [
      "policyId",
      "evaluatorId",
      "maxDepth",
      "maxNodes",
      "leafCacheEntries",
      "leafCacheHistoryMode",
      "temperatureCp",
      "topK",
    ],
    ["opponentAggregation"],
    path,
  );
  const maxDepth = safeIntegerAt(object.maxDepth, `${path}.maxDepth`, 1);
  const maxNodes = safeIntegerAt(object.maxNodes, `${path}.maxNodes`, 2);
  const leafCacheEntries = safeIntegerAt(
    object.leafCacheEntries,
    `${path}.leafCacheEntries`,
    1,
  );
  const leafCacheHistoryMode = stringAt(
    object.leafCacheHistoryMode,
    `${path}.leafCacheHistoryMode`,
  );
  if (
    leafCacheHistoryMode !== "full"
    && leafCacheHistoryMode !== "ignore"
  ) {
    throw new TypeError(
      `${path}.leafCacheHistoryMode must be full or ignore.`,
    );
  }
  const opponentAggregation = object["opponentAggregation"];
  if (
    opponentAggregation !== undefined
    && opponentAggregation !== "worst-case"
    && opponentAggregation !== "posterior-expected"
  ) {
    throw new TypeError(
      `${path}.opponentAggregation must be worst-case or posterior-expected.`,
    );
  }
  const temperatureCp = object.temperatureCp;
  if (
    typeof temperatureCp !== "number"
    || !Number.isFinite(temperatureCp)
    || temperatureCp <= 0
  ) {
    throw new TypeError(`${path}.temperatureCp must be finite and positive.`);
  }
  const topK =
    object.topK === null
      ? null
      : safeIntegerAt(object.topK, `${path}.topK`, 1);
  return {
    policyId: singleLineIdentifierAt(object.policyId, `${path}.policyId`),
    evaluatorId: singleLineIdentifierAt(
      object.evaluatorId,
      `${path}.evaluatorId`,
    ),
    maxDepth,
    maxNodes,
    leafCacheEntries,
    leafCacheHistoryMode,
    ...(opponentAggregation === undefined
      ? {}
      : { opponentAggregation }),
    temperatureCp,
    topK,
  };
}

function colorsAt(
  value: unknown,
  path: string,
  rulesetVersion: PlayerPrivateRulesetVersion,
): { readonly white: TraceRuleSecret; readonly black: TraceRuleSecret } {
  const object = objectAt(value, path);
  exactKeys(object, ["white", "black"], [], path);
  return {
    white: playerPrivateSecretAt(
      object.white,
      `${path}.white`,
      rulesetVersion,
    ),
    black: playerPrivateSecretAt(
      object.black,
      `${path}.black`,
      rulesetVersion,
    ),
  };
}

function moveListAt(value: unknown, path: string): readonly string[] {
  const moves = [...stringListAt(value, path)].sort();
  if (new Set(moves).size !== moves.length) {
    throw new TypeError(`${path} must not contain duplicate moves.`);
  }
  if (moves.some((move) => !UCI_MOVE_PATTERN.test(move))) {
    throw new TypeError(`${path} must contain only standard UCI moves.`);
  }
  return moves;
}

function singleLineIdentifierAt(value: unknown, path: string): string {
  const identifier = stringAt(value, path);
  if (identifier !== identifier.trim() || /[\r\n]/u.test(identifier)) {
    throw new TypeError(`${path} must be trimmed and single-line.`);
  }
  return identifier;
}

function unsignedSeedAt(value: unknown, path: string): number {
  const seed = safeIntegerAt(value, path);
  if (seed > 0xffff_ffff) {
    throw new TypeError(`${path} must be an unsigned 32-bit integer.`);
  }
  return seed;
}
