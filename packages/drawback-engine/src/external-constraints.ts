import type { RandomSource } from "@drawbackengine/shared";
import type {
  ChessMove,
  DrawbackLoss,
  RuleEvidence,
  RuleInitializationContext,
  RuleLossContext,
  RuleMoveContext,
  RuleTransitionContext,
  RuleVerification,
} from "./types.js";

export type ExternalConstraintProvider = "uci-best-move";

export interface ExternalTurnConstraintRequest {
  readonly provider: ExternalConstraintProvider;
  readonly policyId: string;
  readonly positionKey: string;
  readonly fen: string;
  readonly ordinaryRootMoves: readonly string[];
}

export interface ExternalTurnConstraint {
  readonly provider: ExternalConstraintProvider;
  readonly policyId: string;
  readonly positionKey: string;
  readonly requestDigest: string;
  readonly bestMoveUci: string;
  readonly engineFingerprint: string;
}

export interface ExternalConstraintResolutionOptions {
  /**
   * Stops this caller from waiting. A shared deterministic cache fill may
   * continue so cancellation cannot disrupt other sessions.
   */
  readonly signal?: AbortSignal;
}

export interface ExternalTurnConstraintProvider {
  resolve(
    request: ExternalTurnConstraintRequest,
    options?: ExternalConstraintResolutionOptions,
  ): Promise<ExternalTurnConstraint>;
  dispose(): Promise<void>;
}

/**
 * A drawback whose turn mask needs a constraint prepared outside the pure rule
 * engine. Implementations construct requests and consume already-resolved
 * constraints, but never import or invoke an evaluator.
 */
export interface ExternalConstraintDrawbackRule<State, Parameters> {
  readonly kind: "external-turn-constraint";
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly verification: Exclude<RuleVerification, "unsupported">;

  generateParameters(rng: RandomSource): Parameters;
  initialize(context: RuleInitializationContext<Parameters>): State;

  requestTurnConstraint(
    context: RuleMoveContext<State, Parameters>,
    ordinaryMoves: readonly ChessMove[],
  ): ExternalTurnConstraintRequest;

  filterLegalMovesWithConstraint(
    context: RuleMoveContext<State, Parameters>,
    ordinaryMoves: readonly ChessMove[],
    constraint: ExternalTurnConstraint,
  ): readonly ChessMove[];

  applyMove(
    context: RuleTransitionContext<State, Parameters>,
    move: ChessMove,
  ): State;

  checkStartOfTurnLoss(
    context: RuleLossContext<State, Parameters>,
  ): DrawbackLoss | null;

  explainMove?(
    context: RuleMoveContext<State, Parameters>,
    move: ChessMove,
    constraint: ExternalTurnConstraint,
  ): readonly RuleEvidence[];
}
