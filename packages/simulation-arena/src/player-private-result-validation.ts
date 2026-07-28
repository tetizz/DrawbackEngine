import {
  DEFAULT_PLAYER_PRIVATE_LEAF_CACHE_ENTRIES,
} from "@drawbackengine/drawback-search";
import {
  CapturableKingPosition,
} from "@drawbackengine/chess-core";
import {
  assertExactKeys,
  protocolRecord,
  type IndexedPlayerPrivateAssignment,
  type PlayerPrivateGameAssignment,
  type PlayerPrivateSearchPolicy,
  type PlayerPrivateWorkerRequest,
  type PlayerPrivateWorkerResponse,
} from "./player-private-parallel-protocol.js";
import {
  assertPlayerPrivateWorkerTaskResultEnvelope,
  type PlayerPrivateWorkerIdentity,
  type PlayerPrivateWorkerTaskResult,
} from "./player-private-worker-protocol.js";
import {
  validatePlayerPrivateTerminal,
} from "./player-private-terminal-validation.js";

export function assertPlayerPrivateWorkerResponse(
  value: unknown,
  assignedGames: PlayerPrivateWorkerRequest["assignedGames"],
  policy: PlayerPrivateSearchPolicy,
  maxPlies?: number,
): asserts value is PlayerPrivateWorkerResponse {
  const response = protocolRecord(value, "player-private worker response");
  assertExactKeys(
    response,
    ["schemaVersion", "kind", "games"],
    "player-private worker response",
  );
  if (
    response["schemaVersion"] !== 1
    || response["kind"] !== "player-private-results"
  ) {
    throw new TypeError("Player-private worker response is invalid.");
  }
  validateGames(
    response["games"],
    assignedGames,
    policy,
    maxPlies,
  );
}

export function assertPlayerPrivateWorkerTaskResult(
  value: unknown,
  expectedIdentity: PlayerPrivateWorkerIdentity,
  expectedTaskId: number,
  expectedAttempt: number,
  assignedGames: readonly IndexedPlayerPrivateAssignment[],
  policy: PlayerPrivateSearchPolicy,
  maxPlies?: number,
): asserts value is PlayerPrivateWorkerTaskResult {
  assertPlayerPrivateWorkerTaskResultEnvelope(
    value,
    expectedIdentity,
    expectedTaskId,
    expectedAttempt,
  );
  validateGames(value.games, assignedGames, policy, maxPlies);
}

function validateGames(
  value: unknown,
  assignedGames: readonly IndexedPlayerPrivateAssignment[],
  policy: PlayerPrivateSearchPolicy,
  maxPlies?: number,
): void {
  if (
    !Array.isArray(value)
    || value.length !== assignedGames.length
  ) {
    throw new TypeError("Player-private worker response is invalid.");
  }
  const expected = new Map(
    assignedGames.map((game) => [game.gameIndex, game.assignment]),
  );
  const seen = new Set<number>();
  for (const raw of value) {
    const game = protocolRecord(raw, "indexed player-private result");
    assertExactKeys(
      game,
      ["gameIndex", "result"],
      "indexed player-private result",
    );
    const gameIndex = game["gameIndex"];
    if (
      !Number.isSafeInteger(gameIndex)
      || seen.has(gameIndex as number)
    ) {
      throw new RangeError(
        "Player-private response indexes must be unique integers.",
      );
    }
    seen.add(gameIndex as number);
    const assignment = expected.get(gameIndex as number);
    if (assignment === undefined) {
      throw new RangeError(
        "Player-private response contains an unassigned game index.",
      );
    }
    validatePlayerPrivateResult(
      game["result"],
      assignment,
      policy,
      maxPlies,
    );
  }
}

function validatePlayerPrivateResult(
  value: unknown,
  assignment: PlayerPrivateGameAssignment,
  policy: PlayerPrivateSearchPolicy,
  maxPlies?: number,
): void {
  const result = protocolRecord(value, "player-private result");
  assertExactKeys(
    result,
    [
      "authorityId",
      "seed",
      "parameterSeeds",
      "plyLimit",
      "initialFen",
      "result",
      "plies",
      "finalFen",
      "drawbacks",
      "drawbackSecrets",
      "hypothesisPolicyId",
      "agents",
      "stoppedAtPlyLimit",
    ],
    "player-private result",
  );
  const expectedPlyLimit = maxPlies ?? 300;
  if (
    result["authorityId"] !== "capturable-king/v1"
    || result["seed"] !== assignment.seed
    || result["plyLimit"] !== expectedPlyLimit
  ) {
    throw new TypeError(
      "Player-private result authority, seed, or ply limit does not match its assignment.",
    );
  }
  validateParameterSeeds(
    result["parameterSeeds"],
    assignment.parameterSeeds,
  );
  const expectedHypothesisPolicyId =
    policy.opponentHypotheses.kind === "audited-uniform"
      ? "audited-uniform/v1"
      : "unrestricted-baseline/v1";
  if (result["hypothesisPolicyId"] !== expectedHypothesisPolicyId) {
    throw new TypeError(
      "Player-private result hypothesis provenance is invalid.",
    );
  }
  validateAgents(result["agents"], policy);
  validateDrawbackLabels(result, assignment);
  validatePositionChain(result, assignment, expectedPlyLimit);
}

function validateParameterSeeds(
  value: unknown,
  expected: PlayerPrivateGameAssignment["parameterSeeds"],
): void {
  const seeds = protocolRecord(
    value,
    "player-private result parameter seeds",
  );
  assertExactKeys(
    seeds,
    ["white", "black"],
    "player-private result parameter seeds",
  );
  if (
    seeds["white"] !== expected.white
    || seeds["black"] !== expected.black
  ) {
    throw new TypeError(
      "Player-private result parameter seeds do not match its assignment.",
    );
  }
}

function validateAgents(
  value: unknown,
  policy: PlayerPrivateSearchPolicy,
): void {
  const agents = protocolRecord(value, "player-private result agents");
  assertExactKeys(agents, ["white", "black"], "player-private result agents");
  const expectedSearchPolicy = {
    policyId: policy.policyId,
    evaluatorId: "drawback-material/v1",
    maxDepth: policy.maxDepth,
    maxNodes: policy.maxNodes,
    leafCacheEntries:
      policy.leafCacheEntries
      ?? DEFAULT_PLAYER_PRIVATE_LEAF_CACHE_ENTRIES,
    leafCacheHistoryMode: policy.leafCacheHistoryMode ?? "full",
    opponentAggregation:
      policy.opponentAggregation ?? "worst-case",
    temperatureCp: policy.temperatureCp,
    topK: policy.topK ?? null,
  };
  for (const color of ["white", "black"] as const) {
    const agent = protocolRecord(
      agents[color],
      `player-private result ${color} agent`,
    );
    assertExactKeys(
      agent,
      ["id", "style", "strength", "searchPolicy"],
      `player-private result ${color} agent`,
    );
    if (
      agent["id"] !== policy.policyId
      || agent["style"] !== "drawback-search"
      || agent["strength"] !== null
      ||
      JSON.stringify(agent["searchPolicy"])
      !== JSON.stringify(expectedSearchPolicy)
    ) {
      throw new TypeError(
        `Player-private result ${color} search provenance is invalid.`,
      );
    }
  }
}

function validateDrawbackLabels(
  result: Record<string, unknown>,
  assignment: PlayerPrivateGameAssignment,
): void {
  const drawbacks = protocolRecord(
    result["drawbacks"],
    "player-private result drawbacks",
  );
  assertExactKeys(
    drawbacks,
    ["white", "black"],
    "player-private result drawbacks",
  );
  if (
    drawbacks["white"] !== assignment.whiteRuleId
    || drawbacks["black"] !== assignment.blackRuleId
  ) {
    throw new TypeError(
      "Player-private result labels do not match their assignment.",
    );
  }
  const secrets = protocolRecord(
    result["drawbackSecrets"],
    "player-private result drawback secrets",
  );
  assertExactKeys(
    secrets,
    ["initial", "final"],
    "player-private result drawback secrets",
  );
  for (const phase of ["initial", "final"] as const) {
    const reveal = protocolRecord(
      secrets[phase],
      `player-private ${phase} secret reveal`,
    );
    assertExactKeys(
      reveal,
      ["white", "black"],
      `player-private ${phase} secret reveal`,
    );
    for (const color of ["white", "black"] as const) {
      const secret = protocolRecord(
        reveal[color],
        `player-private ${phase} ${color} secret`,
      );
      assertExactKeys(
        secret,
        ["drawbackId", "parameters", "state"],
        `player-private ${phase} ${color} secret`,
      );
      if (
        secret["drawbackId"]
        !== (
          color === "white"
            ? assignment.whiteRuleId
            : assignment.blackRuleId
        )
      ) {
        throw new TypeError(
          `Player-private ${phase} ${color} secret label is invalid.`,
        );
      }
      protocolRecord(
        secret["parameters"],
        `player-private ${phase} ${color} parameters`,
      );
      protocolRecord(
        secret["state"],
        `player-private ${phase} ${color} state`,
      );
    }
  }
}

function validatePositionChain(
  result: Record<string, unknown>,
  assignment: PlayerPrivateGameAssignment,
  expectedPlyLimit: number,
): void {
  if (
    typeof result["initialFen"] !== "string"
    || typeof result["finalFen"] !== "string"
    || !Array.isArray(result["plies"])
  ) {
    throw new TypeError(
      "Player-private result position chain is invalid.",
    );
  }
  const expectedInitialFen =
    assignment.initialFen ?? CapturableKingPosition.fromFen().fen;
  if (result["initialFen"] !== expectedInitialFen) {
    throw new TypeError(
      "Player-private result initial FEN does not match its assignment.",
    );
  }
  const plies = result["plies"];
  if (plies.length > expectedPlyLimit) {
    throw new RangeError(
      "Player-private result exceeds its requested ply limit.",
    );
  }
  let fen = result["initialFen"];
  for (const [plyIndex, rawPly] of plies.entries()) {
    const ply = protocolRecord(rawPly, "player-private result ply");
    assertExactKeys(
      ply,
      ["ply", "color", "observation", "drawback"],
      "player-private result ply",
    );
    const observation = protocolRecord(
      ply["observation"],
      "player-private result observation",
    );
    assertExactKeys(
      observation,
      [
        "authorityId",
        "fenBefore",
        "fenAfter",
        "move",
        "authorityLegalMoves",
        "drawbackLegalMoves",
        "ruleTriggered",
        "forced",
        "orthodoxCompatibleAfter",
      ],
      "player-private result observation",
    );
    const activeFen = fen.split(/\s+/u)[1];
    const expectedColor =
      activeFen === "w" ? "white" : activeFen === "b" ? "black" : null;
    if (
      ply["ply"] !== plyIndex
      || ply["color"] !== expectedColor
      || observation["authorityId"] !== "capturable-king/v1"
      || observation["fenBefore"] !== fen
      || typeof observation["fenAfter"] !== "string"
      || !Array.isArray(observation["authorityLegalMoves"])
      || !Array.isArray(observation["drawbackLegalMoves"])
      || typeof observation["ruleTriggered"] !== "boolean"
      || typeof observation["forced"] !== "boolean"
      || typeof observation["orthodoxCompatibleAfter"] !== "boolean"
    ) {
      throw new TypeError(
        "Player-private result has a discontinuous ply chain.",
      );
    }
    validateMoveAndDrawback(
      observation,
      ply,
      assignment,
      expectedColor,
    );
    fen = observation["fenAfter"];
  }
  if (fen !== result["finalFen"]) {
    throw new TypeError(
      "Player-private result final FEN is discontinuous.",
    );
  }
  const terminal = protocolRecord(
    result["result"],
    "player-private result terminal",
  );
  validatePlayerPrivateTerminal(terminal, assignment);
  const active = terminal["kind"] === "active";
  if (
    (
      active
      && (
        plies.length !== expectedPlyLimit
        || result["stoppedAtPlyLimit"] !== true
      )
    )
    || (!active && result["stoppedAtPlyLimit"] !== false)
  ) {
    throw new TypeError(
      "Player-private stoppedAtPlyLimit is inconsistent.",
    );
  }
}

function validateMoveAndDrawback(
  observation: Record<string, unknown>,
  ply: Record<string, unknown>,
  assignment: PlayerPrivateGameAssignment,
  expectedColor: "white" | "black" | null,
): void {
  const move = protocolRecord(
    observation["move"],
    "player-private result move",
  );
  if (
    typeof move["from"] !== "string"
    || typeof move["to"] !== "string"
    || move["color"] !== expectedColor
  ) {
    throw new TypeError(
      "Player-private result move metadata is invalid.",
    );
  }
  const activeDrawback = protocolRecord(
    ply["drawback"],
    "player-private active drawback",
  );
  if (
    activeDrawback["drawbackId"]
    !== (
      expectedColor === "white"
        ? assignment.whiteRuleId
        : assignment.blackRuleId
    )
  ) {
    throw new TypeError(
      "Player-private active drawback label is invalid.",
    );
  }
}
