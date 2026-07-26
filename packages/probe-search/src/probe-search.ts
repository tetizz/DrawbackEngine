import type {
  AsyncProbeSearchOptions,
  ChessAssessment,
  DiagnosticMoveScore,
  EliminationExplanation,
  ProbeHypothesis,
  ProbeRecommendations,
  ProbeSearchOptions,
  ProbeWeights,
  ReplyBranch,
} from "./types.js";

const DEFAULT_WEIGHTS: ProbeWeights = {
  informationGain: 1,
  chessQuality: 0.25,
  worstCase: 0.5,
  risk: 1,
};

function entropy(probabilities: readonly number[]): number {
  const value = -probabilities.reduce(
    (sum, probability) =>
      probability === 0 ? sum : sum + probability * Math.log(probability),
    0,
  );
  return value === 0 ? 0 : value;
}

function assertFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite.`);
  }
}

function activeHypotheses<State>(
  hypotheses: readonly ProbeHypothesis<State>[],
): readonly ProbeHypothesis<State>[] {
  const active = hypotheses.filter((hypothesis) => !hypothesis.eliminated);
  if (active.length === 0) {
    throw new RangeError("Probe search requires at least one active hypothesis.");
  }
  const ids = new Set<string>();
  for (const hypothesis of active) {
    if (ids.has(hypothesis.drawbackId)) {
      throw new RangeError(`Duplicate active hypothesis id: ${hypothesis.drawbackId}.`);
    }
    ids.add(hypothesis.drawbackId);
    assertFinite(`Probability for ${hypothesis.drawbackId}`, hypothesis.probability);
    if (hypothesis.probability < 0) {
      throw new RangeError(`Probability for ${hypothesis.drawbackId} cannot be negative.`);
    }
  }
  const total = active.reduce((sum, hypothesis) => sum + hypothesis.probability, 0);
  if (total <= 0) {
    throw new RangeError("Active hypothesis probability must have positive mass.");
  }
  return active.map((hypothesis) => ({
    ...hypothesis,
    probability: hypothesis.probability / total,
  }));
}

function resolvedWeights(weights: Partial<ProbeWeights> | undefined): ProbeWeights {
  const resolved = { ...DEFAULT_WEIGHTS, ...weights };
  for (const [name, value] of Object.entries(resolved)) {
    assertFinite(`Weight ${name}`, value);
  }
  return resolved;
}

interface WeightedReply<Reply> {
  readonly reply: Reply;
  readonly likelihood: number;
}

type ProbeStructureOptions<Move, Reply, State> = Omit<
  ProbeSearchOptions<Move, Reply, State>,
  "assessChess"
>;

function weightedReplies<Move, Reply, State>(
  options: ProbeStructureOptions<Move, Reply, State>,
  move: Move,
  hypothesis: ProbeHypothesis<State>,
): readonly WeightedReply<Reply>[] {
  const replies = options.permittedReplies(move, hypothesis);
  if (replies.length === 0) {
    throw new RangeError(
      `Hypothesis ${hypothesis.drawbackId} produced no reply outcome; represent terminal outcomes explicitly.`,
    );
  }
  const seen = new Set<string>();
  const raw = replies.map((reply) => {
    const key = options.replyKey(reply);
    if (seen.has(key)) {
      throw new RangeError(
        `permittedReplies returned duplicate reply key "${key}" for ${hypothesis.drawbackId}.`,
      );
    }
    seen.add(key);
    const likelihood =
      options.replyLikelihood?.(reply, replies, hypothesis, move) ??
      1 / replies.length;
    assertFinite(`Reply likelihood for ${key}`, likelihood);
    if (likelihood < 0) {
      throw new RangeError(`Reply likelihood for ${key} cannot be negative.`);
    }
    return { reply, likelihood };
  });
  const total = raw.reduce((sum, reply) => sum + reply.likelihood, 0);
  if (total <= 0) {
    throw new RangeError(
      `Reply likelihoods for ${hypothesis.drawbackId} must have positive mass.`,
    );
  }
  return raw.map((reply) => ({ ...reply, likelihood: reply.likelihood / total }));
}

type UnassessedMoveScore<Move, Reply> = Omit<
  DiagnosticMoveScore<Move, Reply>,
  keyof ChessAssessment | "diagnosticScore"
>;

function inferMoveScore<Move, Reply, State>(
  options: ProbeStructureOptions<Move, Reply, State>,
  move: Move,
  hypotheses: readonly ProbeHypothesis<State>[],
): UnassessedMoveScore<Move, Reply> {
  const currentEntropy = entropy(hypotheses.map(({ probability }) => probability));
  const replyRepresentatives = new Map<string, Reply>();
  const jointByReply = new Map<string, Map<string, number>>();

  for (const hypothesis of hypotheses) {
    for (const weightedReply of weightedReplies(options, move, hypothesis)) {
      const key = options.replyKey(weightedReply.reply);
      replyRepresentatives.set(key, weightedReply.reply);
      const byHypothesis = jointByReply.get(key) ?? new Map<string, number>();
      byHypothesis.set(
        hypothesis.drawbackId,
        hypothesis.probability * weightedReply.likelihood,
      );
      jointByReply.set(key, byHypothesis);
    }
  }

  const totalReplyMass = [...jointByReply.values()].reduce(
    (sum, byHypothesis) =>
      sum + [...byHypothesis.values()].reduce((replySum, mass) => replySum + mass, 0),
    0,
  );
  if (totalReplyMass <= 0) {
    throw new RangeError("Every active hypothesis produced zero permitted replies.");
  }

  const branches: ReplyBranch<Reply>[] = [];
  for (const [key, byHypothesis] of jointByReply) {
    const rawBranchMass = [...byHypothesis.values()].reduce((sum, mass) => sum + mass, 0);
    const branchProbability = rawBranchMass / totalReplyMass;
    const posterior = hypotheses.map((hypothesis) => ({
      id: hypothesis.drawbackId,
      probability: (byHypothesis.get(hypothesis.drawbackId) ?? 0) / rawBranchMass,
    }));
    const representative = replyRepresentatives.get(key);
    if (representative === undefined) {
      throw new Error(`Internal error: missing representative for reply "${key}".`);
    }
    branches.push({
      reply: representative,
      probability: branchProbability,
      posteriorEntropy: entropy(posterior.map(({ probability }) => probability)),
      survivingHypothesisIds: posterior
        .filter(({ probability }) => probability > 0)
        .map(({ id }) => id),
      eliminatedHypothesisIds: posterior
        .filter(({ probability }) => probability === 0)
        .map(({ id }) => id),
    });
  }

  const expectedPosteriorEntropy = branches.reduce(
    (sum, branch) => sum + branch.probability * branch.posteriorEntropy,
    0,
  );
  const eliminations: EliminationExplanation<Reply>[] = hypotheses.flatMap(
    (hypothesis) => {
      const impossibleAfterReplies = branches
        .filter((branch) => branch.eliminatedHypothesisIds.includes(hypothesis.drawbackId))
        .map((branch) => branch.reply);
      return impossibleAfterReplies.length === 0
        ? []
        : [
            {
              drawbackId: hypothesis.drawbackId,
              impossibleAfterReplies,
              explanation:
                `${hypothesis.drawbackId} would be eliminated by each listed reply ` +
                "because that reply is impossible under the hypothesis.",
            },
          ];
    },
  );
  const informationGain = Math.max(0, currentEntropy - expectedPosteriorEntropy);
  return {
    move,
    currentEntropy,
    expectedPosteriorEntropy,
    informationGain,
    replyBranches: branches,
    eliminations,
  };
}

function completeMoveScore<Move, Reply>(
  inferred: UnassessedMoveScore<Move, Reply>,
  assessment: ChessAssessment,
  weights: ProbeWeights,
): DiagnosticMoveScore<Move, Reply> {
  assertFinite("chessQuality", assessment.chessQuality);
  assertFinite("worstCase", assessment.worstCase);
  assertFinite("risk", assessment.risk);
  return {
    ...inferred,
    ...assessment,
    diagnosticScore:
      weights.informationGain * inferred.informationGain +
      weights.chessQuality * assessment.chessQuality +
      weights.worstCase * assessment.worstCase -
      weights.risk * assessment.risk,
  };
}

function maximumBy<Move, Reply>(
  scores: readonly DiagnosticMoveScore<Move, Reply>[],
  value: (score: DiagnosticMoveScore<Move, Reply>) => number,
): DiagnosticMoveScore<Move, Reply> {
  const first = scores[0];
  if (first === undefined) {
    throw new RangeError("Probe search requires at least one candidate move.");
  }
  return scores.slice(1).reduce(
    (best, candidate) => (value(candidate) > value(best) ? candidate : best),
    first,
  );
}

export function searchDiagnosticMoves<Move, Reply, State = unknown>(
  options: ProbeSearchOptions<Move, Reply, State>,
): ProbeRecommendations<Move, Reply> {
  if (options.moves.length === 0) {
    throw new RangeError("Probe search requires at least one candidate move.");
  }
  const hypotheses = activeHypotheses(options.hypotheses);
  const weights = resolvedWeights(options.weights);
  const scores = options.moves.map((move) =>
    completeMoveScore(
      inferMoveScore(options, move, hypotheses),
      options.assessChess(move),
      weights,
    ),
  );
  return recommendations(scores);
}

function recommendations<Move, Reply>(
  scores: readonly DiagnosticMoveScore<Move, Reply>[],
): ProbeRecommendations<Move, Reply> {
  const ranked = [...scores].sort((left, right) => right.diagnosticScore - left.diagnosticScore);
  const first = scores[0];
  if (first === undefined) {
    throw new RangeError("Probe search requires at least one candidate move.");
  }
  const safest = scores.slice(1).reduce((best, candidate) => {
    if (candidate.worstCase !== best.worstCase) {
      return candidate.worstCase > best.worstCase ? candidate : best;
    }
    if (candidate.risk !== best.risk) {
      return candidate.risk < best.risk ? candidate : best;
    }
    return candidate.diagnosticScore > best.diagnosticScore ? candidate : best;
  }, first);
  return {
    ranked,
    strongestChessMove: maximumBy(scores, ({ chessQuality }) => chessQuality),
    safestDiagnosticMove: safest,
    highestInformationMove: maximumBy(scores, ({ informationGain }) => informationGain),
  };
}

export async function searchDiagnosticMovesAsync<Move, Reply, State = unknown>(
  options: AsyncProbeSearchOptions<Move, Reply, State>,
): Promise<ProbeRecommendations<Move, Reply>> {
  throwIfAborted(options.signal);
  if (options.moves.length === 0) {
    throw new RangeError("Probe search requires at least one candidate move.");
  }
  const hypotheses = activeHypotheses(options.hypotheses);
  const weights = resolvedWeights(options.weights);
  const scores: DiagnosticMoveScore<Move, Reply>[] = [];
  for (const move of options.moves) {
    throwIfAborted(options.signal);
    const inferred = inferMoveScore(options, move, hypotheses);
    const assessment = await options.assessChess(move);
    throwIfAborted(options.signal);
    scores.push(completeMoveScore(inferred, assessment, weights));
  }
  return recommendations(scores);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("Diagnostic probe search was aborted.", "AbortError");
  }
}
