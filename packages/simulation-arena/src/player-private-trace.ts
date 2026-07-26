import {
  CapturableKingPosition,
  type RuleSecretSnapshot,
} from "@drawbackengine/chess-core";
import {
  canonicalMoveUci,
  isAuditedCapturableKingRuleId,
  type ChessMove,
  type PromotionPiece,
} from "@drawbackengine/drawback-engine";
import {
  PLAYER_PRIVATE_SIMULATION_TRACE_FORMAT,
  PLAYER_PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
  parsePlayerPrivateSimulationTraceRecord,
  playerPrivateSimulationGameId,
  type PlayerPrivateSimulationTraceRecord,
  type TracePlayerPrivateAgent,
  type TraceRuleSecret,
} from "@drawbackengine/simulation-trace";
import {
  SIMULATION_RANDOM_POLICY,
} from "@drawbackengine/shared";
import type {
  PlayerPrivateAgentSnapshot,
  PlayerPrivateSimulationResult,
} from "./player-private-simulation.js";
import { toTraceJsonValue } from "./trace-json.js";

export function createPlayerPrivateSimulationTrace(
  game: PlayerPrivateSimulationResult,
  gameIndex: number,
): PlayerPrivateSimulationTraceRecord {
  const hypothesisPolicy = traceHypothesisPolicy(game.hypothesisPolicyId);
  const position = CapturableKingPosition.fromFen(game.initialFen);
  const initialPosition = position.snapshot();
  const plies = game.plies.map((ply) => {
    const positionBefore = position.snapshot();
    if (positionBefore.fen !== ply.observation.fenBefore) {
      throw new TypeError(
        `game.plies[${String(ply.ply)}].observation.fenBefore diverges from authority replay.`,
      );
    }
    const applied = position.move(commandFromMove(ply.observation.move));
    if (applied === null) {
      throw new TypeError(
        `game.plies[${String(ply.ply)}] is not capturable-authority legal.`,
      );
    }
    const positionAfter = position.snapshot();
    if (
      positionAfter.fen !== ply.observation.fenAfter
      || positionAfter.orthodoxCompatible
        !== ply.observation.orthodoxCompatibleAfter
      || canonicalMoveUci(applied.move)
        !== canonicalMoveUci(ply.observation.move)
      || applied.move.san !== ply.observation.move.san
    ) {
      throw new TypeError(
        `game.plies[${String(ply.ply)}].observation diverges from authority replay.`,
      );
    }
    return {
      ply: ply.ply,
      color: ply.color,
      positionBefore,
      positionAfter,
      move: {
        uci: canonicalMoveUci(ply.observation.move),
        san: ply.observation.move.san,
      },
      authorityLegalMoves:
        ply.observation.authorityLegalMoves.map(canonicalMoveUci),
      drawbackLegalMoves:
        ply.observation.drawbackLegalMoves.map(canonicalMoveUci),
      ruleTriggered: ply.observation.ruleTriggered,
      forced: ply.observation.forced,
      activeSecret: toSecret(
        ply.drawback,
        `game.plies[${String(ply.ply)}].drawback`,
      ),
    };
  });
  const finalPosition = position.snapshot();
  if (finalPosition.fen !== game.finalFen) {
    throw new TypeError(
      "game.finalFen diverges from capturable authority replay.",
    );
  }
  if (
    game.drawbackSecrets.initial.white.drawbackId !== game.drawbacks.white
    || game.drawbackSecrets.initial.black.drawbackId !== game.drawbacks.black
  ) {
    throw new TypeError(
      "game drawback reveal diverges from the initial secret snapshot.",
    );
  }
  const record: PlayerPrivateSimulationTraceRecord = {
    format: PLAYER_PRIVATE_SIMULATION_TRACE_FORMAT,
    schemaVersion: PLAYER_PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
    authorityId: "capturable-king/v1",
    ruleset: {
      kind: "audited-player-private",
      version: PLAYER_PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
    },
    randomPolicy: SIMULATION_RANDOM_POLICY,
    gameIndex,
    gameId: playerPrivateSimulationGameId(
      game.seed,
      gameIndex,
      game.parameterSeeds,
    ),
    seed: game.seed,
    parameterSeeds: game.parameterSeeds,
    plyLimit: game.plyLimit,
    initialPosition,
    finalPosition,
    result: game.result,
    stoppedAtPlyLimit: game.stoppedAtPlyLimit,
    hypothesisPolicy,
    secrets: {
      initial: {
        white: toSecret(
          game.drawbackSecrets.initial.white,
          "game.drawbackSecrets.initial.white",
        ),
        black: toSecret(
          game.drawbackSecrets.initial.black,
          "game.drawbackSecrets.initial.black",
        ),
      },
      final: {
        white: toSecret(
          game.drawbackSecrets.final.white,
          "game.drawbackSecrets.final.white",
        ),
        black: toSecret(
          game.drawbackSecrets.final.black,
          "game.drawbackSecrets.final.black",
        ),
      },
    },
    agents: {
      white: toAgent(game.agents.white, "game.agents.white"),
      black: toAgent(game.agents.black, "game.agents.black"),
    },
    plies,
  };
  return parsePlayerPrivateSimulationTraceRecord(record);
}

function traceHypothesisPolicy(
  id: string,
): PlayerPrivateSimulationTraceRecord["hypothesisPolicy"] {
  if (id === "unrestricted-baseline/v1") {
    return { kind: "unrestricted-baseline", version: 1 };
  }
  if (id === "audited-uniform/v1") {
    return { kind: "audited-uniform", version: 1 };
  }
  throw new TypeError(
    "Player-private trace has an unsupported opponent hypothesis policy.",
  );
}

function toSecret(
  secret: RuleSecretSnapshot<unknown, unknown>,
  path: string,
): TraceRuleSecret {
  if (!isAuditedCapturableKingRuleId(secret.drawbackId)) {
    throw new TypeError(`${path}.drawbackId is outside the audited ruleset.`);
  }
  return {
    drawbackId: secret.drawbackId,
    hiddenParameters: toTraceJsonValue(
      secret.parameters,
      `${path}.parameters`,
    ),
    drawbackInternalState: toTraceJsonValue(
      secret.state,
      `${path}.state`,
    ),
  };
}

function toAgent(
  agent: PlayerPrivateAgentSnapshot,
  path: string,
): TracePlayerPrivateAgent {
  if (agent.style !== "drawback-search" || agent.searchPolicy === null) {
    throw new TypeError(
      `${path} must carry complete drawback-search provenance.`,
    );
  }
  return {
    id: agent.id,
    style: "drawback-search",
    strength: agent.strength,
    searchPolicy: {
      policyId: agent.searchPolicy.policyId,
      evaluatorId: agent.searchPolicy.evaluatorId,
      maxDepth: agent.searchPolicy.maxDepth,
      maxNodes: agent.searchPolicy.maxNodes,
      leafCacheEntries: requiredCacheEntries(
        agent.searchPolicy.leafCacheEntries,
        path,
      ),
      leafCacheHistoryMode: agent.searchPolicy.leafCacheHistoryMode,
      opponentAggregation:
        agent.searchPolicy.opponentAggregation ?? "worst-case",
      temperatureCp: agent.searchPolicy.temperatureCp,
      topK: agent.searchPolicy.topK,
    },
  };
}

function requiredCacheEntries(
  value: number | null,
  path: string,
): number {
  if (value === null) {
    throw new TypeError(
      `${path}.searchPolicy.leafCacheEntries must be materialized.`,
    );
  }
  return value;
}

function commandFromMove(move: ChessMove): {
  readonly from: string;
  readonly to: string;
  readonly promotion?: PromotionPiece;
} {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
}
