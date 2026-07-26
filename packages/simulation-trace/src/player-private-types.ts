import type {
  CapturableKingPositionSnapshot,
  SessionResult,
} from "@drawbackengine/chess-core";
import type {
  AuditedCapturableKingRuleId,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";
import type {
  JsonValue,
  TraceMove,
} from "./types.js";

export const PLAYER_PRIVATE_SIMULATION_TRACE_FORMAT =
  "drawbackengine-player-private-simulation-trace" as const;
export const PLAYER_PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION = 1 as const;

export interface TraceRuleSecret {
  readonly drawbackId: AuditedCapturableKingRuleId;
  readonly hiddenParameters: JsonValue;
  readonly drawbackInternalState: JsonValue;
}

export interface TracePlayerPrivateSearchPolicy {
  readonly policyId: string;
  readonly evaluatorId: string;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly leafCacheEntries: number;
  readonly leafCacheHistoryMode: "full" | "ignore";
  /**
   * Absent only on historical schema-v1 traces, which used worst-case.
   * New producers always materialize the aggregation mode.
   */
  readonly opponentAggregation?:
    | "worst-case"
    | "posterior-expected";
  readonly temperatureCp: number;
  readonly topK: number | null;
}

export interface TracePlayerPrivateAgent {
  readonly id: string;
  readonly style: "drawback-search";
  readonly strength: number | null;
  readonly searchPolicy: TracePlayerPrivateSearchPolicy;
}

export interface PlayerPrivateSimulationTracePly {
  readonly ply: number;
  readonly color: PlayerColor;
  readonly positionBefore: CapturableKingPositionSnapshot;
  readonly positionAfter: CapturableKingPositionSnapshot;
  readonly move: TraceMove;
  readonly authorityLegalMoves: readonly string[];
  readonly drawbackLegalMoves: readonly string[];
  readonly ruleTriggered: boolean;
  readonly forced: boolean;
  readonly activeSecret: TraceRuleSecret;
}

/**
 * Privileged whole-game record for player-private capturable-king self-play.
 *
 * Position snapshots, moves, and authority-legal masks are public
 * observations. Drawback masks, trigger facts, results, parameters, internal
 * states, and both secret snapshots are labels and must never enter model
 * inputs. Seeds, indices, policies, and agent metadata are provenance only.
 */
export interface PlayerPrivateSimulationTraceRecord {
  readonly format: typeof PLAYER_PRIVATE_SIMULATION_TRACE_FORMAT;
  readonly schemaVersion:
    typeof PLAYER_PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION;
  readonly authorityId: "capturable-king/v1";
  readonly ruleset: {
    readonly kind: "audited-player-private";
    readonly version: 1;
  };
  readonly randomPolicy: {
    readonly kind: "explicit-parameter-seeds-domain-agent-mulberry32";
    readonly version: 1;
  };
  readonly gameIndex: number;
  readonly gameId: string;
  readonly seed: number;
  readonly parameterSeeds: {
    readonly white: number;
    readonly black: number;
  };
  readonly plyLimit: number;
  readonly initialPosition: CapturableKingPositionSnapshot;
  readonly finalPosition: CapturableKingPositionSnapshot;
  readonly result: SessionResult;
  readonly stoppedAtPlyLimit: boolean;
  readonly hypothesisPolicy:
    | {
        readonly kind: "unrestricted-baseline";
        readonly version: 1;
      }
    | {
        readonly kind: "audited-uniform";
        readonly version: 1;
      };
  readonly secrets: {
    readonly initial: {
      readonly white: TraceRuleSecret;
      readonly black: TraceRuleSecret;
    };
    readonly final: {
      readonly white: TraceRuleSecret;
      readonly black: TraceRuleSecret;
    };
  };
  readonly agents: {
    readonly white: TracePlayerPrivateAgent;
    readonly black: TracePlayerPrivateAgent;
  };
  readonly plies: readonly PlayerPrivateSimulationTracePly[];
}
