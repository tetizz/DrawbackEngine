import type {
  PlayerPrivateSimulationResult,
} from "./player-private-simulation.js";
import {
  CapturableKingPosition,
} from "@drawbackengine/chess-core";
import {
  PLAYER_PRIVATE_RULE_IDS,
  type PlayerPrivateRuleId,
} from "./player-private-catalog.js";
import type {
  PlayerPrivateOpponentAggregation,
} from "@drawbackengine/drawback-search";

export interface PlayerPrivateSearchPolicy {
  readonly policyId: string;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly temperatureCp: number;
  readonly topK?: number;
  readonly leafCacheEntries?: number;
  readonly leafCacheHistoryMode?: "full" | "ignore";
  readonly opponentAggregation?: PlayerPrivateOpponentAggregation;
  readonly evaluator: {
    readonly kind: "material";
    readonly version: 1;
  };
  readonly opponentHypotheses: PlayerPrivateOpponentHypothesisPolicy;
}

export type PlayerPrivateOpponentHypothesisPolicy =
  | {
      readonly kind: "unrestricted-baseline";
      readonly version: 1;
    }
  | {
      readonly kind: "audited-uniform";
      readonly version: 1;
    };

export interface PlayerPrivateGameAssignment {
  readonly seed: number;
  readonly parameterSeeds: {
    readonly white: number;
    readonly black: number;
  };
  readonly whiteRuleId: PlayerPrivateRuleId;
  readonly blackRuleId: PlayerPrivateRuleId;
  readonly initialFen?: string;
}

export interface PlayerPrivateAssignmentBatchRequest {
  readonly assignments: readonly PlayerPrivateGameAssignment[];
  readonly workers: number;
  readonly policy: PlayerPrivateSearchPolicy;
  readonly maxPlies?: number;
}

interface IndexedPlayerPrivateResult {
  readonly gameIndex: number;
  readonly result: PlayerPrivateSimulationResult;
}

export interface PlayerPrivateWorkerRequest {
  readonly schemaVersion: 1;
  readonly kind: "player-private-assignments";
  readonly assignedGames: readonly {
    readonly gameIndex: number;
    readonly assignment: PlayerPrivateGameAssignment;
  }[];
  readonly policy: PlayerPrivateSearchPolicy;
  readonly maxPlies?: number;
}

export interface PlayerPrivateWorkerResponse {
  readonly schemaVersion: 1;
  readonly kind: "player-private-results";
  readonly games: readonly IndexedPlayerPrivateResult[];
}

export function assertPlayerPrivateWorkerRequest(
  value: unknown,
): asserts value is PlayerPrivateWorkerRequest {
  const request = protocolRecord(value, "player-private worker request");
  if (
    request["schemaVersion"] !== 1
    || request["kind"] !== "player-private-assignments"
  ) {
    throw new TypeError(
      "Player-private worker request schema/kind is unsupported.",
    );
  }
  const expected = [
    "schemaVersion",
    "kind",
    "assignedGames",
    "policy",
  ];
  if (request["maxPlies"] !== undefined) {
    expected.push("maxPlies");
    assertPositiveSafeInteger(request["maxPlies"] as number, "maxPlies");
  }
  assertExactKeys(request, expected, "player-private worker request");
  assertPlayerPrivateSearchPolicy(request["policy"]);
  if (
    !Array.isArray(request["assignedGames"])
    || request["assignedGames"].length === 0
  ) {
    throw new TypeError("assignedGames must be a non-empty array.");
  }
  const indexes = new Set<number>();
  for (const raw of request["assignedGames"]) {
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

export function assertPlayerPrivateGameAssignment(value: unknown): void {
  const assignment = protocolRecord(value, "player-private assignment");
  const expected = [
    "seed",
    "parameterSeeds",
    "whiteRuleId",
    "blackRuleId",
  ];
  if (assignment["initialFen"] !== undefined) {
    expected.push("initialFen");
  }
  assertExactKeys(
    assignment,
    expected,
    "player-private assignment",
  );
  const seed = assignment["seed"];
  if (
    !Number.isSafeInteger(seed)
    || (seed as number) < 0
    || (seed as number) > 0xffff_ffff
  ) {
    throw new RangeError("Player-private assignment seed must be uint32.");
  }
  const parameterSeeds = protocolRecord(
    assignment["parameterSeeds"],
    "player-private assignment parameterSeeds",
  );
  assertExactKeys(
    parameterSeeds,
    ["white", "black"],
    "player-private assignment parameterSeeds",
  );
  for (const color of ["white", "black"] as const) {
    const parameterSeed = parameterSeeds[color];
    if (
      !Number.isSafeInteger(parameterSeed)
      || (parameterSeed as number) < 0
      || (parameterSeed as number) > 0xffff_ffff
    ) {
      throw new RangeError(
        `Player-private ${color} parameter seed must be uint32.`,
      );
    }
  }
  for (const key of ["whiteRuleId", "blackRuleId"] as const) {
    if (
      !PLAYER_PRIVATE_RULE_IDS.includes(
        assignment[key] as PlayerPrivateRuleId,
      )
    ) {
      throw new RangeError(`${key} is outside the player-private catalog.`);
    }
  }
  if (
    assignment["initialFen"] !== undefined
    && (
      typeof assignment["initialFen"] !== "string"
      || assignment["initialFen"].trim() !== assignment["initialFen"]
      || assignment["initialFen"].length === 0
      || /[\r\n]/u.test(assignment["initialFen"])
    )
  ) {
    throw new RangeError(
      "Player-private assignment initialFen must be a non-empty single-line string.",
    );
  }
  if (
    typeof assignment["initialFen"] === "string"
    && CapturableKingPosition.fromFen(assignment["initialFen"]).fen
      !== assignment["initialFen"]
  ) {
    throw new RangeError(
      "Player-private assignment initialFen must be canonical.",
    );
  }
}

export function assertPlayerPrivateSearchPolicy(value: unknown): void {
  const policy = protocolRecord(value, "player-private search policy");
  const expected = [
    "policyId",
    "maxDepth",
    "maxNodes",
    "temperatureCp",
    "evaluator",
    "opponentHypotheses",
  ];
  if (policy["topK"] !== undefined) {
    expected.push("topK");
    assertPositiveSafeInteger(policy["topK"] as number, "topK");
  }
  if (policy["leafCacheEntries"] !== undefined) {
    expected.push("leafCacheEntries");
    assertPositiveSafeInteger(
      policy["leafCacheEntries"] as number,
      "leafCacheEntries",
    );
  }
  if (policy["leafCacheHistoryMode"] !== undefined) {
    expected.push("leafCacheHistoryMode");
    if (
      policy["leafCacheHistoryMode"] !== "full"
      && policy["leafCacheHistoryMode"] !== "ignore"
    ) {
      throw new RangeError(
        "leafCacheHistoryMode must be full or ignore.",
      );
    }
  }
  if (policy["opponentAggregation"] !== undefined) {
    expected.push("opponentAggregation");
    if (
      policy["opponentAggregation"] !== "worst-case"
      && policy["opponentAggregation"] !== "posterior-expected"
    ) {
      throw new TypeError(
        "opponentAggregation must be worst-case or posterior-expected.",
      );
    }
  }
  assertExactKeys(policy, expected, "player-private search policy");
  if (
    typeof policy["policyId"] !== "string"
    || policy["policyId"].trim().length === 0
    || policy["policyId"] !== policy["policyId"].trim()
    || /[\r\n]/u.test(policy["policyId"])
  ) {
    throw new RangeError("policyId must not be empty.");
  }
  assertPositiveSafeInteger(policy["maxDepth"] as number, "maxDepth");
  assertPositiveSafeInteger(policy["maxNodes"] as number, "maxNodes");
  if ((policy["maxNodes"] as number) <= 1) {
    throw new RangeError("maxNodes must be greater than one.");
  }
  if (
    typeof policy["temperatureCp"] !== "number"
    || !Number.isFinite(policy["temperatureCp"])
    || policy["temperatureCp"] <= 0
  ) {
    throw new RangeError("temperatureCp must be finite and positive.");
  }
  const evaluator = protocolRecord(policy["evaluator"], "policy evaluator");
  assertExactKeys(evaluator, ["kind", "version"], "policy evaluator");
  if (
    evaluator["kind"] !== "material"
    || evaluator["version"] !== 1
  ) {
    throw new TypeError("Only material evaluator v1 is supported.");
  }
  const opponent = protocolRecord(
    policy["opponentHypotheses"],
    "opponent hypothesis policy",
  );
  assertExactKeys(
    opponent,
    ["kind", "version"],
    "opponent hypothesis policy",
  );
  if (
    (
      opponent["kind"] !== "unrestricted-baseline"
      && opponent["kind"] !== "audited-uniform"
    )
    || opponent["version"] !== 1
  ) {
    throw new TypeError(
      "Only unrestricted-baseline or audited-uniform opponent hypotheses v1 are supported.",
    );
  }
}

export function assertPositiveSafeInteger(
  value: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

export function protocolRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    throw new TypeError(`${label} has invalid fields.`);
  }
}
