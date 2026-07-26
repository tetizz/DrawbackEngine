import type { ChessMove } from "@drawbackengine/drawback-engine";
import type { RandomSource } from "@drawbackengine/shared";
import type { IterativeRootMoveScore } from "./iterative-search.js";

export interface RootTemperatureSelectionOptions {
  /** Softmax temperature in centipawns. */
  readonly temperatureCp: number;
  /** Optionally sample only among the strongest K exact root scores. */
  readonly topK?: number;
}

export interface RootMoveProbability {
  readonly move: ChessMove;
  readonly score: number;
  readonly probability: number;
}

export interface RootTemperatureSelection {
  readonly move: ChessMove;
  readonly score: number;
  readonly probability: number;
  readonly distribution: readonly RootMoveProbability[];
}

/**
 * Deterministic-seed sampling over fully scored roots.
 *
 * This creates realistic self-play variety without permitting a move that the
 * exact drawback search did not score. It consumes exactly one RNG sample.
 */
export function selectRootMoveByTemperature(
  rootScores: readonly IterativeRootMoveScore[],
  rng: RandomSource,
  options: RootTemperatureSelectionOptions,
): RootTemperatureSelection {
  validateOptions(rootScores, options);
  const ordered = [...rootScores]
    .sort((left, right) =>
      right.score - left.score
      || moveId(left.move).localeCompare(moveId(right.move))
    )
    .slice(0, options.topK ?? rootScores.length);
  const maximum = ordered[0]?.score;
  if (maximum === undefined) {
    throw new RangeError("Root temperature selection requires scored moves.");
  }
  const weights = ordered.map((entry) =>
    Math.exp((entry.score - maximum) / options.temperatureCp)
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Root temperature weights have no finite mass.");
  }
  const distribution = Object.freeze(
    ordered.map((entry, index) =>
      Object.freeze({
        move: structuredClone(entry.move),
        score: entry.score,
        probability: (weights[index] ?? 0) / total,
      })
    ),
  );
  const sample = rng.next();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("Random source must return a value in [0, 1).");
  }
  let cumulative = 0;
  let selected = distribution.at(-1);
  for (const candidate of distribution) {
    cumulative += candidate.probability;
    if (sample < cumulative) {
      selected = candidate;
      break;
    }
  }
  if (selected === undefined) {
    throw new Error("Root temperature selection produced no move.");
  }
  return Object.freeze({
    move: structuredClone(selected.move),
    score: selected.score,
    probability: selected.probability,
    distribution,
  });
}

function validateOptions(
  rootScores: readonly IterativeRootMoveScore[],
  options: RootTemperatureSelectionOptions,
): void {
  if (
    !Number.isFinite(options.temperatureCp)
    || options.temperatureCp <= 0
  ) {
    throw new RangeError(
      "Root temperature must be finite and greater than zero.",
    );
  }
  if (
    options.topK !== undefined
    && (
      !Number.isSafeInteger(options.topK)
      || options.topK <= 0
      || options.topK > rootScores.length
    )
  ) {
    throw new RangeError(
      "Root temperature topK must select an available positive move count.",
    );
  }
  const seen = new Set<string>();
  for (const entry of rootScores) {
    if (!Number.isFinite(entry.score)) {
      throw new RangeError("Root move score must be finite.");
    }
    const id = moveId(entry.move);
    if (seen.has(id)) {
      throw new RangeError(`Duplicate root move score: ${id}.`);
    }
    seen.add(id);
  }
}

function moveId(
  move: Pick<ChessMove, "from" | "to" | "promotion">,
): string {
  return `${move.from}${move.to}${move.promotion?.[0] ?? ""}`;
}
