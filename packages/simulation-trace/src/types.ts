import type { SessionResult } from "@drawbackengine/chess-core";
import type { ExternalTurnConstraint } from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface TraceAgentSnapshot {
  readonly id: string;
  readonly style: string | null;
  readonly strength: number | null;
}

export interface TraceMove {
  readonly uci: string;
  readonly san: string;
}

export interface TraceActiveSecret {
  readonly drawbackId: string;
  readonly hiddenParameters: JsonValue;
  readonly drawbackInternalState: JsonValue;
}

export interface PrivateSimulationTracePly {
  readonly ply: number;
  readonly color: PlayerColor;
  readonly fenBefore: string;
  readonly fenAfter: string;
  readonly move: TraceMove;
  readonly ordinaryLegalMoves: readonly string[];
  readonly drawbackLegalMoves: readonly string[];
  readonly ruleTriggered: boolean;
  readonly forced: boolean;
  readonly publicEvaluatorConstraint: ExternalTurnConstraint | null;
  readonly activeSecret: TraceActiveSecret;
}

export interface TraceHiddenDrawbackReveal {
  readonly white: string;
  readonly black: string;
}

export const PRIVATE_SIMULATION_TRACE_FORMAT =
  "drawbackengine-private-simulation-trace" as const;
export const PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION = 1 as const;

/**
 * One privileged whole-game trace record.
 *
 * Consumers must treat `game.plies[*].drawback` and `game.drawbacks` as labels,
 * not observations. The record is intentionally private even after a game
 * ends because it can contain arbitrary rule parameters and internal state.
 */
export interface PrivateSimulationTraceRecord {
  readonly format: typeof PRIVATE_SIMULATION_TRACE_FORMAT;
  readonly schemaVersion: typeof PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION;
  readonly authorityId: "standard-chess/v1";
  readonly gameIndex: number;
  readonly gameId: string;
  readonly seed: number;
  readonly plyLimit: number;
  readonly initialFen: string;
  readonly finalFen: string;
  readonly result: SessionResult;
  readonly stoppedAtPlyLimit: boolean;
  readonly evaluatorCoverage: "none" | "uniform";
  readonly drawbacks: TraceHiddenDrawbackReveal;
  readonly agents: {
    readonly white: TraceAgentSnapshot;
    readonly black: TraceAgentSnapshot;
  };
  readonly plies: readonly PrivateSimulationTracePly[];
}
