export interface ProbeHypothesis<State = unknown> {
  readonly drawbackId: string;
  readonly probability: number;
  readonly eliminated: boolean;
  readonly state: State;
}

export interface ProbeWeights {
  readonly informationGain: number;
  readonly chessQuality: number;
  readonly worstCase: number;
  readonly risk: number;
}

export interface ChessAssessment {
  readonly chessQuality: number;
  readonly worstCase: number;
  readonly risk: number;
}

export interface ReplyBranch<Reply> {
  readonly reply: Reply;
  readonly probability: number;
  readonly posteriorEntropy: number;
  readonly survivingHypothesisIds: readonly string[];
  readonly eliminatedHypothesisIds: readonly string[];
}

export interface EliminationExplanation<Reply> {
  readonly drawbackId: string;
  readonly impossibleAfterReplies: readonly Reply[];
  readonly explanation: string;
}

export interface DiagnosticMoveScore<Move, Reply> extends ChessAssessment {
  readonly move: Move;
  readonly currentEntropy: number;
  readonly expectedPosteriorEntropy: number;
  readonly informationGain: number;
  readonly diagnosticScore: number;
  readonly replyBranches: readonly ReplyBranch<Reply>[];
  readonly eliminations: readonly EliminationExplanation<Reply>[];
}

export interface ProbeRecommendations<Move, Reply> {
  readonly ranked: readonly DiagnosticMoveScore<Move, Reply>[];
  readonly strongestChessMove: DiagnosticMoveScore<Move, Reply>;
  readonly safestDiagnosticMove: DiagnosticMoveScore<Move, Reply>;
  readonly highestInformationMove: DiagnosticMoveScore<Move, Reply>;
}

export interface ProbeSearchOptions<Move, Reply, State = unknown> {
  readonly moves: readonly Move[];
  readonly hypotheses: readonly ProbeHypothesis<State>[];
  readonly permittedReplies: (
    move: Move,
    hypothesis: ProbeHypothesis<State>,
  ) => readonly Reply[];
  readonly replyKey: (reply: Reply) => string;
  readonly assessChess: (move: Move) => ChessAssessment;
  readonly replyLikelihood?: (
    reply: Reply,
    permittedReplies: readonly Reply[],
    hypothesis: ProbeHypothesis<State>,
    move: Move,
  ) => number;
  readonly weights?: Partial<ProbeWeights>;
}

export type AsyncProbeSearchOptions<Move, Reply, State = unknown> = Omit<
  ProbeSearchOptions<Move, Reply, State>,
  "assessChess"
> & {
  readonly assessChess: (
    move: Move,
  ) => ChessAssessment | PromiseLike<ChessAssessment>;
  /**
   * Cancels assessment between candidates. The assessment callback should
   * pass the same signal to any long-running evaluator so an in-flight
   * candidate can stop promptly as well.
   */
  readonly signal?: AbortSignal;
};
