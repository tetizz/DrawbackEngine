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
import {
  deriveNodeUciLeafEvaluatorId,
  type NodeUciLeafEvaluatorConfig,
} from "@drawbackengine/chess-evaluator";

export type PlayerPrivateEvaluatorPolicy =
  | {
      readonly kind: "material";
      readonly version: 1;
    }
  | {
      readonly kind: "node-uci-leaf";
      readonly version: 1;
      /** Purely derived path-free identity; its configuration stays parent-only. */
      readonly evaluatorId: string;
      readonly config: NodeUciLeafEvaluatorConfig;
    };

export type PlayerPrivateWorkerEvaluatorPolicy =
  | Extract<PlayerPrivateEvaluatorPolicy, { readonly kind: "material" }>
  | Omit<
      Extract<PlayerPrivateEvaluatorPolicy, { readonly kind: "node-uci-leaf" }>,
      "config"
    >;

export interface PlayerPrivateSearchPolicy {
  readonly policyId: string;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly temperatureCp: number;
  readonly topK?: number;
  readonly leafCacheEntries?: number;
  readonly leafCacheHistoryMode?: "full" | "ignore";
  readonly opponentAggregation?: PlayerPrivateOpponentAggregation;
  readonly evaluator: PlayerPrivateEvaluatorPolicy;
  readonly opponentHypotheses: PlayerPrivateOpponentHypothesisPolicy;
}

export type PlayerPrivateWorkerSearchPolicy = Omit<
  PlayerPrivateSearchPolicy,
  "evaluator"
> & {
  readonly evaluator: PlayerPrivateWorkerEvaluatorPolicy;
};

export type PlayerPrivateLegacySearchPolicy = Omit<
  PlayerPrivateSearchPolicy,
  "evaluator"
> & {
  readonly evaluator: Extract<
    PlayerPrivateEvaluatorPolicy,
    { readonly kind: "material" }
  >;
};

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

export interface IndexedPlayerPrivateAssignment {
  readonly gameIndex: number;
  readonly assignment: PlayerPrivateGameAssignment;
}

export interface IndexedPlayerPrivateResult {
  readonly gameIndex: number;
  readonly result: PlayerPrivateSimulationResult;
}

export interface PlayerPrivateWorkerRequest {
  readonly schemaVersion: 1;
  readonly kind: "player-private-assignments";
  readonly assignedGames: readonly IndexedPlayerPrivateAssignment[];
  readonly policy: PlayerPrivateLegacySearchPolicy;
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
  assertPlayerPrivateLegacySearchPolicy(request["policy"]);
  assertIndexedPlayerPrivateAssignments(request["assignedGames"]);
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
  assertSearchPolicyWithEvaluator(value, assertPlayerPrivateEvaluatorPolicy);
}

export function assertPlayerPrivateLegacySearchPolicy(value: unknown): void {
  const policy = protocolRecord(value, "legacy player-private search policy");
  const evaluator = protocolRecord(
    policy["evaluator"],
    "legacy player-private evaluator",
  );
  if (evaluator["kind"] !== "material") {
    throw new TypeError(
      "Legacy workers accept only the path-free material evaluator.",
    );
  }
  assertSearchPolicyWithEvaluator(value, assertPlayerPrivateEvaluatorPolicy);
}

export function assertPlayerPrivateWorkerSearchPolicy(value: unknown): void {
  assertSearchPolicyWithEvaluator(
    value,
    assertPlayerPrivateWorkerEvaluatorPolicy,
  );
}

function assertSearchPolicyWithEvaluator(
  value: unknown,
  assertEvaluator: (candidate: unknown) => void,
): void {
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
      && policy["opponentAggregation"] !== "posterior-cvar-25"
    ) {
      throw new TypeError(
        "opponentAggregation must be worst-case, posterior-expected, "
          + "or posterior-cvar-25.",
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
  assertEvaluator(policy["evaluator"]);
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

function assertPlayerPrivateEvaluatorPolicy(
  value: unknown,
): asserts value is PlayerPrivateEvaluatorPolicy {
  const evaluator = protocolRecord(value, "policy evaluator");
  if (evaluator["kind"] === "material") {
    assertExactKeys(evaluator, ["kind", "version"], "policy evaluator");
    if (evaluator["version"] !== 1) {
      throw new TypeError("Only material evaluator v1 is supported.");
    }
    return;
  }
  assertExactKeys(
    evaluator,
    ["kind", "version", "evaluatorId", "config"],
    "policy evaluator",
  );
  if (
    evaluator["kind"] !== "node-uci-leaf"
    || evaluator["version"] !== 1
    || typeof evaluator["evaluatorId"] !== "string"
    || !/^node-uci-leaf\/v1\/[0-9a-f]{64}$/u.test(
      evaluator["evaluatorId"],
    )
  ) {
    throw new TypeError("Node UCI leaf evaluator policy v1 is invalid.");
  }
  const config = assertExactNodeUciLeafConfig(evaluator["config"]);
  const derived = deriveNodeUciLeafEvaluatorId(config);
  if (derived !== evaluator["evaluatorId"]) {
    throw new TypeError(
      "Node UCI leaf evaluator ID does not match its pinned configuration.",
    );
  }
}

function assertPlayerPrivateWorkerEvaluatorPolicy(value: unknown): void {
  const evaluator = protocolRecord(value, "worker policy evaluator");
  if (evaluator["kind"] === "material") {
    assertExactKeys(
      evaluator,
      ["kind", "version"],
      "worker policy evaluator",
    );
    if (evaluator["version"] !== 1) {
      throw new TypeError("Only material worker evaluator v1 is supported.");
    }
    return;
  }
  assertExactKeys(
    evaluator,
    ["kind", "version", "evaluatorId"],
    "worker policy evaluator",
  );
  if (
    evaluator["kind"] !== "node-uci-leaf"
    || evaluator["version"] !== 1
    || typeof evaluator["evaluatorId"] !== "string"
    || !/^node-uci-leaf\/v1\/[0-9a-f]{64}$/u.test(evaluator["evaluatorId"])
  ) {
    throw new TypeError("Node UCI worker evaluator descriptor is invalid.");
  }
}

function assertExactNodeUciLeafConfig(
  value: unknown,
): NodeUciLeafEvaluatorConfig {
  const config = protocolRecord(value, "Node UCI leaf configuration");
  const kind = config["kind"];
  if (kind !== "stockfish" && kind !== "fairy-stockfish") {
    throw new TypeError("Node UCI leaf engine kind is invalid.");
  }
  const expected = [
    "kind",
    "process",
    "client",
    "engineIdentity",
    "depth",
    "hashMb",
    "unsupportedPosition",
  ];
  if (kind === "fairy-stockfish") {
    expected.push("fairyVariant");
  }
  assertExactKeys(config, expected, "Node UCI leaf configuration");

  const processConfig = protocolRecord(
    config["process"],
    "Node UCI process configuration",
  );
  const processKeys = [
    "executablePath",
    "executableSha256",
    "cwd",
    "shutdownTimeoutMs",
    "runtimeContextSha256",
  ];
  if (processConfig["args"] !== undefined) {
    processKeys.push("args");
    if (
      !Array.isArray(processConfig["args"])
      || processConfig["args"].some((argument) =>
        typeof argument !== "string"
      )
    ) {
      throw new TypeError("Node UCI process arguments are invalid.");
    }
  }
  assertExactKeys(
    processConfig,
    processKeys,
    "Node UCI process configuration",
  );
  const client = protocolRecord(
    config["client"],
    "Node UCI client configuration",
  );
  assertExactKeys(client, ["timeoutMs"], "Node UCI client configuration");
  const identity = protocolRecord(
    config["engineIdentity"],
    "Node UCI engine identity",
  );
  assertExactKeys(
    identity,
    ["uciName", "engine", "version", "advertisedOptionsSha256"],
    "Node UCI engine identity",
  );
  if (kind === "fairy-stockfish") {
    const variant = protocolRecord(
      config["fairyVariant"],
      "Fairy-Stockfish variant",
    );
    assertExactKeys(
      variant,
      ["bytes", "sha256"],
      "Fairy-Stockfish variant",
    );
    if (!(variant["bytes"] instanceof Uint8Array)) {
      throw new TypeError(
        "Fairy-Stockfish variant bytes must be a Uint8Array.",
      );
    }
  }
  return config as unknown as NodeUciLeafEvaluatorConfig;
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
