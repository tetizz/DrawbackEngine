import { playerPrivateSimulationGameId } from "./game-id.js";
import { resultAt } from "./field-parsers.js";
import {
  booleanAt,
  exactKeys,
  objectAt,
  safeIntegerAt,
} from "./parse-primitives.js";
import {
  playerPrivateAgentAt,
  playerPrivateParameterSeedsAt,
  playerPrivatePlyAt,
  playerPrivateSecretsAt,
  playerPrivateSnapshotAt,
  requireLiteralPolicy,
} from "./player-private-field-parsers.js";
import {
  validatePlayerPrivateSemanticReplay,
} from "./player-private-semantic-replay.js";
import {
  PLAYER_PRIVATE_SIMULATION_TRACE_FORMAT,
  PLAYER_PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
  type PlayerPrivateSimulationTraceRecord,
} from "./player-private-types.js";

export function parsePlayerPrivateSimulationTraceRecord(
  value: unknown,
): PlayerPrivateSimulationTraceRecord {
  const object = objectAt(value, "trace");
  exactKeys(
    object,
    [
      "format",
      "schemaVersion",
      "authorityId",
      "ruleset",
      "randomPolicy",
      "gameIndex",
      "gameId",
      "seed",
      "parameterSeeds",
      "plyLimit",
      "initialPosition",
      "finalPosition",
      "result",
      "stoppedAtPlyLimit",
      "hypothesisPolicy",
      "secrets",
      "agents",
      "plies",
    ],
    [],
    "trace",
  );
  if (object.format !== PLAYER_PRIVATE_SIMULATION_TRACE_FORMAT) {
    throw new TypeError("trace.format is unsupported.");
  }
  if (
    object.schemaVersion
    !== PLAYER_PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION
  ) {
    throw new TypeError("trace.schemaVersion is unsupported.");
  }
  if (object.authorityId !== "capturable-king/v1") {
    throw new TypeError("trace.authorityId is unsupported.");
  }
  requireLiteralPolicy(
    object.ruleset,
    "trace.ruleset",
    "audited-player-private",
  );
  requireLiteralPolicy(
    object.randomPolicy,
    "trace.randomPolicy",
    "explicit-parameter-seeds-domain-agent-mulberry32",
  );
  const hypothesisPolicy = hypothesisPolicyAt(
    object.hypothesisPolicy,
    "trace.hypothesisPolicy",
  );
  const gameIndex = safeIntegerAt(object.gameIndex, "trace.gameIndex");
  const seed = safeIntegerAt(object.seed, "trace.seed");
  if (seed > 0xffff_ffff) {
    throw new TypeError("trace.seed must be an unsigned 32-bit integer.");
  }
  const plyLimit = safeIntegerAt(object.plyLimit, "trace.plyLimit", 1);
  const parameterSeeds = playerPrivateParameterSeedsAt(
    object.parameterSeeds,
    "trace.parameterSeeds",
  );
  if (!Array.isArray(object.plies)) {
    throw new TypeError("trace.plies must be an array.");
  }
  const plies = object.plies.map((entry, index) =>
    playerPrivatePlyAt(entry, index, `trace.plies[${String(index)}]`));
  if (plies.length > plyLimit) {
    throw new TypeError("trace.plies cannot exceed trace.plyLimit.");
  }
  const initialPosition = playerPrivateSnapshotAt(
    object.initialPosition,
    "trace.initialPosition",
  );
  const finalPosition = playerPrivateSnapshotAt(
    object.finalPosition,
    "trace.finalPosition",
  );
  validatePositionChain(initialPosition, finalPosition, plies);
  const secrets = playerPrivateSecretsAt(object.secrets, "trace.secrets");
  validateSecretIdentity(secrets, plies);
  const expectedGameId = playerPrivateSimulationGameId(
    seed,
    gameIndex,
    parameterSeeds,
  );
  if (object.gameId !== expectedGameId) {
    throw new TypeError(
      "trace.gameId does not match the format, seed, and game index.",
    );
  }
  const result = resultAt(object.result, "trace.result");
  const stoppedAtPlyLimit = booleanAt(
    object.stoppedAtPlyLimit,
    "trace.stoppedAtPlyLimit",
  );
  if (stoppedAtPlyLimit !== (result.kind === "active")) {
    throw new TypeError(
      "trace.stoppedAtPlyLimit must be true exactly when the result is active.",
    );
  }
  if (stoppedAtPlyLimit && plies.length !== plyLimit) {
    throw new TypeError(
      "A trace stopped at its ply limit must contain exactly plyLimit plies.",
    );
  }
  const agentsObject = objectAt(object.agents, "trace.agents");
  exactKeys(agentsObject, ["white", "black"], [], "trace.agents");
  const record: PlayerPrivateSimulationTraceRecord = {
    format: PLAYER_PRIVATE_SIMULATION_TRACE_FORMAT,
    schemaVersion: PLAYER_PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
    authorityId: "capturable-king/v1",
    ruleset: { kind: "audited-player-private", version: 1 },
    randomPolicy: {
      kind: "explicit-parameter-seeds-domain-agent-mulberry32",
      version: 1,
    },
    gameIndex,
    gameId: expectedGameId,
    seed,
    parameterSeeds,
    plyLimit,
    initialPosition,
    finalPosition,
    result,
    stoppedAtPlyLimit,
    hypothesisPolicy,
    secrets,
    agents: {
      white: playerPrivateAgentAt(
        agentsObject.white,
        "trace.agents.white",
      ),
      black: playerPrivateAgentAt(
        agentsObject.black,
        "trace.agents.black",
      ),
    },
    plies,
  };
  validatePlayerPrivateSemanticReplay(record);
  return record;
}

function hypothesisPolicyAt(
  value: unknown,
  path: string,
): PlayerPrivateSimulationTraceRecord["hypothesisPolicy"] {
  const policy = objectAt(value, path);
  exactKeys(policy, ["kind", "version"], [], path);
  if (
    (
      policy.kind !== "unrestricted-baseline"
      && policy.kind !== "audited-uniform"
    )
    || policy.version !== 1
  ) {
    throw new TypeError(`${path} is unsupported.`);
  }
  return {
    kind: policy.kind,
    version: 1,
  };
}

export function parsePlayerPrivateSimulationTraceLine(
  line: string,
): PlayerPrivateSimulationTraceRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error: unknown) {
    throw new SyntaxError(
      `Player-private simulation trace line is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parsePlayerPrivateSimulationTraceRecord(value);
}

function validatePositionChain(
  initialPosition: PlayerPrivateSimulationTraceRecord["initialPosition"],
  finalPosition: PlayerPrivateSimulationTraceRecord["finalPosition"],
  plies: PlayerPrivateSimulationTraceRecord["plies"],
): void {
  if (
    plies[0] !== undefined
    && !sameValue(plies[0].positionBefore, initialPosition)
  ) {
    throw new TypeError(
      "trace.initialPosition must equal the first ply position.",
    );
  }
  for (let index = 1; index < plies.length; index += 1) {
    if (
      !sameValue(
        plies[index - 1]?.positionAfter,
        plies[index]?.positionBefore,
      )
    ) {
      throw new TypeError(
        "trace.plies must contain one continuous authority-position chain.",
      );
    }
  }
  if (
    plies.at(-1) !== undefined
    && !sameValue(plies.at(-1)?.positionAfter, finalPosition)
  ) {
    throw new TypeError(
      "trace.finalPosition must equal the last ply position.",
    );
  }
  if (plies.length === 0 && !sameValue(initialPosition, finalPosition)) {
    throw new TypeError(
      "A zero-ply trace must have identical initial and final positions.",
    );
  }
}

function validateSecretIdentity(
  secrets: PlayerPrivateSimulationTraceRecord["secrets"],
  plies: PlayerPrivateSimulationTraceRecord["plies"],
): void {
  for (const color of ["white", "black"] as const) {
    if (
      secrets.initial[color].drawbackId
      !== secrets.final[color].drawbackId
    ) {
      throw new TypeError(
        `trace.secrets.${color} drawback IDs cannot change.`,
      );
    }
  }
  for (const [index, ply] of plies.entries()) {
    if (
      ply.activeSecret.drawbackId
      !== secrets.initial[ply.color].drawbackId
    ) {
      throw new TypeError(
        `trace.plies[${String(index)}].activeSecret drawbackId does not match the game secret.`,
      );
    }
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
