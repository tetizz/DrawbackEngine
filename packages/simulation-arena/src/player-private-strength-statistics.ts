export const DEFAULT_STRENGTH_CONFIDENCE_LEVEL = 0.95;

export type CandidateGameScore = 0 | 0.5 | 1 | null;

export interface PairedCandidateGameScores {
  readonly candidateWhite: CandidateGameScore;
  readonly candidateBlack: CandidateGameScore;
}

export interface StrengthScoreBounds {
  readonly lower: number;
  readonly upper: number;
}

export interface StrengthScoreLine {
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly completedGames: number;
  readonly plyLimitGames: number;
  /** Score over completed games only. Null when no game completed. */
  readonly completedGameScore: number | null;
  /** Exact bounds over every scheduled game; ply-limit results remain unknown. */
  readonly scheduledGameScoreBounds: StrengthScoreBounds;
}

export interface PairedScoreUncertainty {
  readonly confidenceLevel: number;
  readonly method: "hoeffding-bounded-pairs-with-censoring";
  readonly radius: number;
  readonly lower: number;
  readonly upper: number;
  readonly pairCount: number;
}

export interface PairedStrengthScoreSummary {
  readonly candidate: StrengthScoreLine;
  readonly baseline: StrengthScoreLine;
  readonly totalGames: number;
  readonly decisiveGames: number;
  readonly drawnGames: number;
  readonly plyLimitGames: number;
  readonly pairCount: number;
  readonly completedPairs: number;
  readonly plyLimitPairs: number;
  /** Mean candidate-minus-50% score among pairs with two completed legs. */
  readonly completedPairMeanDelta: number | null;
  /** Exact all-pair delta when every leg completed; otherwise null. */
  readonly scheduledPairMeanDelta: number | null;
  /** Assumption-free bounds for the realized match with ply-limit legs unknown. */
  readonly scheduledPairMeanDeltaBounds: StrengthScoreBounds;
  /**
   * Conservative sampling interval for a mean paired delta in [-0.5, 0.5].
   * It widens the exact censoring bounds by Hoeffding's two-sided radius.
   */
  readonly pairedDeltaUncertainty: PairedScoreUncertainty;
}

/**
 * Summarizes color-swapped game pairs without treating a ply limit as a draw.
 *
 * The exact censoring interval needs no distributional assumption. The
 * Hoeffding interval additionally assumes the scheduled pairs are independent
 * observations from the benchmark population whose mean is being estimated.
 */
export function summarizePairedStrengthScores(
  pairs: readonly PairedCandidateGameScores[],
  confidenceLevel = DEFAULT_STRENGTH_CONFIDENCE_LEVEL,
): PairedStrengthScoreSummary {
  if (pairs.length === 0) {
    throw new RangeError("Strength scoring requires at least one game pair.");
  }
  if (
    !Number.isFinite(confidenceLevel)
    || confidenceLevel <= 0
    || confidenceLevel >= 1
  ) {
    throw new RangeError("confidenceLevel must be finite and between zero and one.");
  }
  for (const pair of pairs) {
    validateScore(pair.candidateWhite);
    validateScore(pair.candidateBlack);
  }

  const candidateScores = pairs.flatMap((pair) => [
    pair.candidateWhite,
    pair.candidateBlack,
  ]);
  const baselineScores = candidateScores.map(invertScore);
  const candidate = scoreLine(candidateScores);
  const baseline = scoreLine(baselineScores);
  const pairBounds = pairs.map(pairDeltaBounds);
  const completeDeltas = pairBounds.flatMap((bounds) =>
    bounds.lower === bounds.upper ? [bounds.lower] : []
  );
  const scheduledBounds = Object.freeze({
    lower: mean(pairBounds.map(({ lower }) => lower)),
    upper: mean(pairBounds.map(({ upper }) => upper)),
  });
  const alpha = 1 - confidenceLevel;
  const radius = Math.sqrt(
    Math.log(2 / alpha) / (2 * pairs.length),
  );
  const uncertainty = Object.freeze({
    confidenceLevel,
    method: "hoeffding-bounded-pairs-with-censoring" as const,
    radius,
    lower: clampDelta(scheduledBounds.lower - radius),
    upper: clampDelta(scheduledBounds.upper + radius),
    pairCount: pairs.length,
  });
  const allPairsCompleted = completeDeltas.length === pairs.length;

  return Object.freeze({
    candidate,
    baseline,
    totalGames: candidateScores.length,
    decisiveGames: candidate.wins + candidate.losses,
    drawnGames: candidate.draws,
    plyLimitGames: candidate.plyLimitGames,
    pairCount: pairs.length,
    completedPairs: completeDeltas.length,
    plyLimitPairs: pairs.length - completeDeltas.length,
    completedPairMeanDelta:
      completeDeltas.length === 0 ? null : mean(completeDeltas),
    scheduledPairMeanDelta:
      allPairsCompleted ? mean(completeDeltas) : null,
    scheduledPairMeanDeltaBounds: scheduledBounds,
    pairedDeltaUncertainty: uncertainty,
  });
}

function scoreLine(scores: readonly CandidateGameScore[]): StrengthScoreLine {
  const completed = scores.flatMap((score) => score === null ? [] : [score]);
  const wins = completed.filter((score) => score === 1).length;
  const draws = completed.filter((score) => score === 0.5).length;
  const losses = completed.filter((score) => score === 0).length;
  const points = completed.reduce<number>((sum, score) => sum + score, 0);
  const plyLimitGames = scores.length - completed.length;
  return Object.freeze({
    wins,
    draws,
    losses,
    completedGames: completed.length,
    plyLimitGames,
    completedGameScore:
      completed.length === 0 ? null : points / completed.length,
    scheduledGameScoreBounds: Object.freeze({
      lower: points / scores.length,
      upper: (points + plyLimitGames) / scores.length,
    }),
  });
}

function pairDeltaBounds(
  pair: PairedCandidateGameScores,
): StrengthScoreBounds {
  const white = scoreBounds(pair.candidateWhite);
  const black = scoreBounds(pair.candidateBlack);
  return Object.freeze({
    lower: (white.lower + black.lower) / 2 - 0.5,
    upper: (white.upper + black.upper) / 2 - 0.5,
  });
}

function scoreBounds(score: CandidateGameScore): StrengthScoreBounds {
  return score === null
    ? Object.freeze({ lower: 0, upper: 1 })
    : Object.freeze({ lower: score, upper: score });
}

function invertScore(score: CandidateGameScore): CandidateGameScore {
  switch (score) {
    case null:
      return null;
    case 0:
      return 1;
    case 0.5:
      return 0.5;
    case 1:
      return 0;
  }
}

function validateScore(score: CandidateGameScore): void {
  const value: unknown = score;
  if (value !== null && value !== 0 && value !== 0.5 && value !== 1) {
    throw new RangeError("Game scores must be 0, 0.5, 1, or null at a ply limit.");
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot calculate the mean of an empty list.");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampDelta(value: number): number {
  return Math.max(-0.5, Math.min(0.5, value));
}
