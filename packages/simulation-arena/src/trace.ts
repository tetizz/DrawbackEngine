import {
  PRIVATE_SIMULATION_TRACE_FORMAT,
  PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
  parsePrivateSimulationTraceRecord,
  simulationGameId,
  type JsonValue,
  type PrivateSimulationTraceRecord,
} from "@drawbackengine/simulation-trace";
import { toUciMove } from "./stockfish-agent.js";
import type { SimulationResult } from "./simulation.js";

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toJsonValue(value: unknown, path: string, depth = 0): JsonValue {
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
      toJsonValue(entry, `${path}[${String(index)}]`, depth + 1));
  }
  if (
    typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null)
  ) {
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
        toJsonValue(descriptor.value, `${path}.${key}`, depth + 1),
      ]);
    }
    return Object.fromEntries(entries);
  }
  throw new TypeError(`${path} must contain only plain JSON-safe values.`);
}

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
        hiddenParameters: toJsonValue(
          ply.drawback.parameters,
          `game.plies[${String(ply.ply)}].drawback.parameters`,
        ),
        drawbackInternalState: toJsonValue(
          ply.drawback.state,
          `game.plies[${String(ply.ply)}].drawback.state`,
        ),
      },
    })),
  };
  return parsePrivateSimulationTraceRecord(record);
}
