import type {
  PublicGameTrace,
  PublicPositionAuthoritySnapshot,
  StandardChessPositionSnapshot,
} from "@drawbackengine/chess-core";
import type {
  ChessMove,
  PositionAuthorityId,
} from "@drawbackengine/drawback-engine";
import type {
  ChessAssessment,
  ProbeRecommendations,
  ProbeWeights,
} from "@drawbackengine/probe-search";
import type { PlayerColor } from "@drawbackengine/shared";
import type {
  OwnPlayerRuleCapability,
  PublicDrawbackHypothesis,
} from "./player-private-capability.js";
import type { DrawbackLeafEvaluator } from "./types.js";

export interface UnsupportedDiagnosticOpponentAuthority {
  readonly hypothesisId: string;
  readonly drawbackId: string;
  readonly probability: number;
  readonly authorityId: string;
  readonly reason: string;
}

export interface DiagnosticUnsupportedAuthorityFact {
  readonly component:
    | "opponent-hypothesis"
    | "leaf-evaluator"
    | "standard-repetition-adjudicator";
  readonly authorityId: string;
  readonly reason: string;
  readonly hypothesisId?: string;
  readonly drawbackId?: string;
  readonly candidateMoveId?: string;
  readonly evaluatorId?: string;
  readonly probability?: number;
}

export interface StandardRepetitionAdjudicationRequest {
  readonly position: StandardChessPositionSnapshot;
  readonly history: readonly ChessMove[];
}

/**
 * Trusted public adjudicator for the part of standard terminal state that FEN
 * cannot encode. The implementation must reconstruct or authenticate enough
 * public position history to prove both positive and negative answers.
 */
export interface StandardRepetitionAdjudicator {
  readonly id: string;
  adjudicate(
    request: StandardRepetitionAdjudicationRequest,
  ): "threefold-repetition" | "not-threefold-repetition";
}

export interface PlayerPrivateDiagnosticInput {
  /**
   * Authenticated public-only origin, authority replay, and current position.
   * Bare FEN/history pairs are intentionally not accepted as exact evidence.
   */
  readonly trace: PublicGameTrace;
  readonly own: OwnPlayerRuleCapability;
  readonly opponent: readonly PublicDrawbackHypothesis[];
  /**
   * Every positive-mass surviving hypothesis that could not be represented by
   * a capability for this authority. Passing this list explicitly prevents an
   * incomplete posterior from being presented as exact coverage.
   */
  readonly unsupportedOpponentAuthorities:
    readonly UnsupportedDiagnosticOpponentAuthority[];
  /**
   * Omit to assess every exact move allowed by the player's own drawback.
   * A supplied list must be a duplicate-free subset of that exact move set.
   */
  readonly candidateMoves?: readonly ChessMove[];
  readonly evaluator: DrawbackLeafEvaluator;
  /**
   * Required for standard-chess/v1. A bare FEN cannot prove the absence of a
   * threefold repetition, so standard assessment fails closed without this
   * public, provenance-bearing dependency.
   */
  readonly standardRepetitionAdjudicator?: StandardRepetitionAdjudicator;
  readonly weights?: Partial<ProbeWeights>;
  readonly signal?: AbortSignal;
}

export type DiagnosticTerminal =
  | {
      readonly kind: "king-capture";
      readonly winner: PlayerColor;
      readonly loser: PlayerColor;
      readonly method: "direct" | "castling-en-passant";
    }
  | {
      readonly kind: "drawback-loss";
      readonly winner: PlayerColor;
      readonly loser: PlayerColor;
      readonly drawbackId: string;
    }
  | {
      readonly kind: "no-drawback-legal-replies";
      readonly winner: PlayerColor;
      readonly loser: PlayerColor;
      readonly drawbackId: string;
    }
  | {
      readonly kind: "no-legal-moves";
      readonly winner: PlayerColor;
      readonly loser: PlayerColor;
    }
  | {
      readonly kind: "checkmate";
      readonly winner: PlayerColor;
      readonly loser: PlayerColor;
    }
  | {
      readonly kind: "draw";
      readonly winner: null;
      readonly reason:
        | "stalemate"
        | "insufficient-material"
        | "fifty-move"
        | "threefold-repetition";
    };

export type AuthorityDiagnosticReply =
  | {
      readonly kind: "move";
      readonly move: ChessMove;
      readonly position: PublicPositionAuthoritySnapshot;
    }
  | {
      readonly kind: "terminal";
      readonly terminal: DiagnosticTerminal;
      readonly position: PublicPositionAuthoritySnapshot;
      /**
       * Present when the terminal was produced by an opponent reply. It is
       * absent for a terminal reached before the opponent can move.
       */
      readonly reply?: ChessMove;
    };

export interface DiagnosticHypothesisEngineAssessment {
  readonly hypothesisId: string;
  readonly probability: number;
  readonly permittedReplyCount: number;
  /** Centipawns from the root player's perspective. */
  readonly score: number;
  readonly source: "engine" | "terminal" | "engine-and-terminal";
}

/**
 * chessQuality is the posterior-weighted mean of exact-mask engine scores.
 * worstCase is their minimum. risk is posterior-weighted downside below that
 * mean; absolute danger remains visible separately in worstCase.
 */
export interface DiagnosticRootMoveEngineAssessment extends ChessAssessment {
  readonly move: ChessMove;
  readonly hypotheses: readonly DiagnosticHypothesisEngineAssessment[];
}

export interface PlayerPrivateDiagnosticCoverage {
  readonly authorityId: PositionAuthorityId;
  readonly evaluatorId: string;
  readonly standardRepetitionAdjudicatorId: string | null;
  readonly candidateMoveCount: number;
  readonly assessedCandidateMoveCount: number;
  readonly requestedHypothesisCount: number;
  readonly supportedHypothesisCount: number;
  readonly unsupportedHypothesisCount: number;
  /**
   * Fractions are normalized across supported and explicitly unsupported
   * positive-mass hypotheses supplied by the caller.
   */
  readonly supportedHypothesisProbabilityMass: number;
  readonly unsupportedHypothesisProbabilityMass: number;
  readonly exactReplyCoverage: boolean;
  readonly exactAssessmentCoverage: boolean;
  readonly evaluatorCalls: number;
  readonly unsupportedAuthorityFacts:
    readonly DiagnosticUnsupportedAuthorityFact[];
}

export interface CompletePlayerPrivateDiagnosticAssessment {
  readonly status: "complete";
  readonly knowledgeMode: "player-private";
  readonly authorityId: PositionAuthorityId;
  readonly evaluatorId: string;
  readonly coverage: PlayerPrivateDiagnosticCoverage;
  readonly recommendations: ProbeRecommendations<
    ChessMove,
    AuthorityDiagnosticReply
  >;
  readonly moveAssessments: readonly DiagnosticRootMoveEngineAssessment[];
}

export interface UnsupportedPlayerPrivateDiagnosticAssessment {
  readonly status: "unsupported";
  readonly knowledgeMode: "player-private";
  readonly authorityId: PositionAuthorityId;
  readonly evaluatorId: string;
  readonly reason:
    | "unsupported-opponent-authority"
    | "unsupported-leaf-evaluation"
    | "missing-standard-repetition-provenance";
  readonly coverage: PlayerPrivateDiagnosticCoverage;
}

export type PlayerPrivateDiagnosticAssessment =
  | CompletePlayerPrivateDiagnosticAssessment
  | UnsupportedPlayerPrivateDiagnosticAssessment;

export class DiagnosticEvaluatorFailureError extends Error {
  public readonly evaluatorId: string;
  public readonly candidateMoveId: string;
  public readonly hypothesisId: string;

  public constructor(
    evaluatorId: string,
    candidateMoveId: string,
    hypothesisId: string,
    cause: unknown,
  ) {
    super(
      `${evaluatorId} failed while assessing ${candidateMoveId} under ${hypothesisId}.`,
      { cause },
    );
    this.name = "DiagnosticEvaluatorFailureError";
    this.evaluatorId = evaluatorId;
    this.candidateMoveId = candidateMoveId;
    this.hypothesisId = hypothesisId;
  }
}
