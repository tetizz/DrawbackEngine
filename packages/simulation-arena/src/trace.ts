import {
  PRIVATE_SIMULATION_TRACE_FORMAT,
  PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
  parsePrivateSimulationTraceRecord,
  simulationGameId,
  type PrivateSimulationTraceRecord,
} from "@drawbackengine/simulation-trace";
import { toUciMove } from "./stockfish-agent.js";
import { toTraceJsonValue } from "./trace-json.js";
import type { SimulationResult } from "./simulation.js";

/**
 * Projects a trusted in-memory game into the stable private wire contract.
 *
 * The parser is deliberately applied before returning so invalid rule state or
 * a broken FEN chain fails during generation, not later during model training.
 */
export function createPrivateSimulationTrace(
  game: SimulationResult,
  gameIndex: number,
): PrivateSimulationTraceRecord {
  const evaluatorFacts = game.plies.map(
    (ply) => ply.observation.externalConstraint,
  );
  const evaluatorCoverage =
    evaluatorFacts.every((fact) => fact === undefined)
      ? "none"
      : evaluatorFacts.every((fact) => fact !== undefined)
        ? "uniform"
        : null;
  if (evaluatorCoverage === null) {
    throw new TypeError(
      "A private simulation trace cannot mix evaluator-enriched and unenriched plies.",
    );
  }
  const record: PrivateSimulationTraceRecord = {
    format: PRIVATE_SIMULATION_TRACE_FORMAT,
    schemaVersion: PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
    authorityId: "standard-chess/v1",
    gameIndex,
    gameId: simulationGameId(game.seed, gameIndex),
    seed: game.seed,
    plyLimit: game.plyLimit,
    initialFen: game.initialFen,
    finalFen: game.finalFen,
    result: game.result,
    stoppedAtPlyLimit: game.stoppedAtPlyLimit,
    evaluatorCoverage,
    drawbacks: game.drawbacks,
    agents: game.agents,
    plies: game.plies.map((ply) => ({
      ply: ply.ply,
      color: ply.color,
      fenBefore: ply.observation.fenBefore,
      fenAfter: ply.observation.fenAfter,
      move: {
        uci: toUciMove(ply.observation.move),
        san: ply.observation.move.san,
      },
      ordinaryLegalMoves: ply.observation.ordinaryLegalMoves.map(toUciMove),
      drawbackLegalMoves: ply.observation.drawbackLegalMoves.map(toUciMove),
      ruleTriggered: ply.observation.ruleTriggered,
      forced: ply.observation.forced,
      publicEvaluatorConstraint: ply.observation.externalConstraint ?? null,
      activeSecret: {
        drawbackId: ply.drawback.drawbackId,
        hiddenParameters: toTraceJsonValue(
          ply.drawback.parameters,
          `game.plies[${String(ply.ply)}].drawback.parameters`,
        ),
        drawbackInternalState: toTraceJsonValue(
          ply.drawback.state,
          `game.plies[${String(ply.ply)}].drawback.state`,
        ),
      },
    })),
  };
  return parsePrivateSimulationTraceRecord(record);
}
