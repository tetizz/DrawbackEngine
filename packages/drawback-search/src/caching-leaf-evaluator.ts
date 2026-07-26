import type {
  DrawbackLeafEvaluator,
  LeafPosition,
} from "./types.js";

export interface CachingLeafEvaluatorOptions {
  readonly evaluator: DrawbackLeafEvaluator;
  readonly maxEntries: number;
  /**
   * Use "ignore" only when the wrapped evaluator is a pure function of the
   * current authority position and exact legal mask. Stockfish and
   * Fairy-Stockfish leaf adapters satisfy that contract; a history-aware
   * evaluator must retain the default.
   */
  readonly historyMode?: "full" | "ignore";
  readonly id?: string;
}

export interface LeafEvaluationCacheMetrics {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
  readonly evictions: number;
}

export interface CachingDrawbackLeafEvaluator
  extends DrawbackLeafEvaluator {
  metrics(): LeafEvaluationCacheMetrics;
  clear(): void;
}

/**
 * Bounded resolved-value cache for expensive Stockfish/Fairy leaf calls.
 *
 * FEN is deliberately not used as the sole key. Drawback legality can depend
 * on the exact public move history, the filtered legal mask, and the
 * castling-king-en-passant right. Failed and aborted evaluations are never
 * cached.
 */
export function createCachingLeafEvaluator(
  options: CachingLeafEvaluatorOptions,
): CachingDrawbackLeafEvaluator {
  if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
    throw new RangeError(
      "Leaf evaluation cache maxEntries must be a positive safe integer.",
    );
  }
  if (options.evaluator.id.trim().length === 0) {
    throw new RangeError("Wrapped leaf evaluator ID must not be empty.");
  }
  const values = new Map<string, number>();
  const historyMode = options.historyMode ?? "full";
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  return {
    id: options.id ?? `cache/${options.evaluator.id}`,
    async evaluate(position, signal) {
      throwIfAborted(signal);
      const key = leafEvaluationCacheKey(position, historyMode);
      const cached = values.get(key);
      if (cached !== undefined) {
        hits += 1;
        values.delete(key);
        values.set(key, cached);
        return cached;
      }

      misses += 1;
      const score = await options.evaluator.evaluate(position, signal);
      throwIfAborted(signal);
      if (!Number.isFinite(score)) {
        throw new Error(
          `${options.evaluator.id} returned a non-finite leaf score.`,
        );
      }
      values.set(key, score);
      while (values.size > options.maxEntries) {
        const oldest = values.keys().next().value;
        if (oldest === undefined) {
          throw new Error("Leaf evaluation cache eviction invariant failed.");
        }
        values.delete(oldest);
        evictions += 1;
      }
      return score;
    },
    metrics() {
      return Object.freeze({
        hits,
        misses,
        entries: values.size,
        evictions,
      });
    },
    clear() {
      values.clear();
    },
  };
}

function leafEvaluationCacheKey(
  position: LeafPosition,
  historyMode: "full" | "ignore",
): string {
  return JSON.stringify({
    authorityId: position.authorityId,
    fen: position.fen,
    turn: position.turn,
    legalMoves: position.legalMoves.map(moveKey).sort(),
    history:
      historyMode === "full"
        ? position.history.map(historyMoveKey)
        : null,
    orthodoxCompatible: position.orthodoxCompatible,
    kingPassantActive: position.kingPassantActive,
  });
}

function moveKey(
  move: LeafPosition["legalMoves"][number],
): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

function historyMoveKey(
  move: LeafPosition["history"][number],
): readonly [
  string,
  string,
  string,
  string,
  string | null,
  string | null,
  string,
  string,
] {
  return [
    move.from,
    move.to,
    move.color,
    move.piece,
    move.captured ?? null,
    move.promotion ?? null,
    move.san,
    move.flags,
  ];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException(
      "Leaf evaluation cache request was aborted.",
      "AbortError",
    );
  }
}
