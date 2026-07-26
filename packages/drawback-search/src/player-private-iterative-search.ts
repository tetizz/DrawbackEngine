import type { ChessMove } from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";
import {
  createCachingLeafEvaluator,
  type LeafEvaluationCacheMetrics,
} from "./caching-leaf-evaluator.js";
import {
  playerPrivateDrawbackRootMoves,
  searchPlayerPrivateDrawbackRootMove,
  type PlayerPrivateSearchInput,
} from "./player-private-search.js";
import type {
  IterativeRootMoveScore,
  IterativeSearchStopReason,
} from "./iterative-search.js";
import type { DrawbackLeafEvaluator } from "./types.js";

const CACHE_HISTORY_MODES = new Set<string>(["full", "ignore"]);

export type PlayerPrivateSearchContext = Omit<
  PlayerPrivateSearchInput,
  "evaluator" | "limits"
>;

export interface IterativePlayerPrivateSearchLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly leafCacheEntries?: number;
  readonly leafCacheHistoryMode?: "full" | "ignore";
  readonly signal?: AbortSignal;
}

export interface IterativePlayerPrivateSearchResult {
  readonly move: ChessMove;
  /** Centipawns from the root player's perspective. */
  readonly score: number;
  readonly principalVariation: readonly ChessMove[];
  /** Total nodes spent across all attempted depth iterations. */
  readonly nodes: number;
  /** Total requested leaf visits across all attempted depth iterations. */
  readonly leaves: number;
  /** True when maxDepth was not completed. The returned move is never partial. */
  readonly truncated: boolean;
  readonly rootColor: PlayerColor;
  readonly evaluatorId: string;
  readonly knowledgeMode: "player-private";
  readonly aggregation: "worst-case";
  readonly opponentHypothesisCount: number;
  readonly requestedDepth: number;
  readonly completedDepth: number;
  readonly stopReason: IterativeSearchStopReason;
  /** Exact full-window scores from the deepest completed iteration. */
  readonly rootMoves: readonly IterativeRootMoveScore[];
  readonly leafCache: LeafEvaluationCacheMetrics;
}

export class IncompletePlayerPrivateSearchError extends Error {
  public readonly attemptedDepth: number;
  public readonly maxNodes: number;

  public constructor(attemptedDepth: number, maxNodes: number) {
    super(
      `Player-private search could not complete depth ${String(attemptedDepth)} within ${String(maxNodes)} nodes.`,
    );
    this.name = "IncompletePlayerPrivateSearchError";
    this.attemptedDepth = attemptedDepth;
    this.maxNodes = maxNodes;
  }
}

/**
 * Iterative deepening over complete full-window player-private root scores.
 *
 * Partial iterations are discarded. The input contains only a branded exact
 * own-rule capability and independently reconstructed public opponent
 * hypotheses, so this wrapper cannot accept or recover authoritative opponent
 * state.
 */
export async function searchIterativePlayerPrivateDrawbackMove(
  input: PlayerPrivateSearchContext,
  evaluator: DrawbackLeafEvaluator,
  limits: IterativePlayerPrivateSearchLimits,
): Promise<IterativePlayerPrivateSearchResult> {
  validateLimits(limits);
  throwIfAborted(limits.signal);
  const cachedEvaluator = createCachingLeafEvaluator({
    evaluator,
    maxEntries: limits.leafCacheEntries ?? 16_384,
    historyMode: limits.leafCacheHistoryMode ?? "full",
  });
  const baseLimits = {
    depth: 1,
    maxNodes: limits.maxNodes,
    ...(limits.signal === undefined ? {} : { signal: limits.signal }),
  };
  const rootMoves = orderedRootMoves(
    playerPrivateDrawbackRootMoves({
      ...input,
      evaluator: cachedEvaluator,
      limits: baseLimits,
    }),
  );
  let nodes = 0;
  let leaves = 0;
  let completed:
    | {
        readonly selected: IterativeRootMoveScore;
        readonly rootColor: PlayerColor;
      }
    | null = null;
  let completedRootMoves: readonly IterativeRootMoveScore[] = [];
  let completedDepth = 0;

  for (let depth = 1; depth <= limits.maxDepth; depth += 1) {
    throwIfAborted(limits.signal);
    const iteration: IterativeRootMoveScore[] = [];
    let rootColor: PlayerColor | null = null;
    let iterationIncomplete = false;
    for (const rootMove of rootMoves) {
      const remaining = limits.maxNodes - nodes;
      if (remaining <= 1) {
        iterationIncomplete = true;
        break;
      }
      const rootResult = await searchPlayerPrivateDrawbackRootMove(
        {
          ...input,
          evaluator: cachedEvaluator,
          limits: {
            depth,
            maxNodes: remaining,
            ...(limits.signal === undefined
              ? {}
              : { signal: limits.signal }),
          },
        },
        rootMove,
      );
      nodes += rootResult.nodes;
      leaves += rootResult.leaves;
      if (rootResult.truncated) {
        iterationIncomplete = true;
        break;
      }
      if (rootColor !== null && rootColor !== rootResult.rootColor) {
        throw new Error(
          "Player-private root searches returned inconsistent root colors.",
        );
      }
      rootColor = rootResult.rootColor;
      iteration.push(Object.freeze({
        move: structuredClone(rootResult.move),
        score: rootResult.score,
        principalVariation: Object.freeze(
          structuredClone(rootResult.principalVariation),
        ),
      }));
    }
    if (iterationIncomplete) {
      break;
    }
    if (rootColor === null) {
      throw new Error("Completed player-private iteration has no root color.");
    }
    completed = {
      selected: bestRootMove(iteration),
      rootColor,
    };
    completedRootMoves = Object.freeze(iteration);
    completedDepth = depth;
  }

  if (completed === null) {
    throw new IncompletePlayerPrivateSearchError(1, limits.maxNodes);
  }
  const reachedTarget = completedDepth === limits.maxDepth;
  return Object.freeze({
    move: structuredClone(completed.selected.move),
    score: completed.selected.score,
    principalVariation: Object.freeze(
      structuredClone(completed.selected.principalVariation),
    ),
    nodes,
    leaves,
    truncated: !reachedTarget,
    rootColor: completed.rootColor,
    evaluatorId: evaluator.id,
    knowledgeMode: "player-private",
    aggregation: "worst-case",
    opponentHypothesisCount: input.opponent.length,
    requestedDepth: limits.maxDepth,
    completedDepth,
    stopReason: reachedTarget ? "target-depth" : "node-budget",
    rootMoves: completedRootMoves,
    leafCache: cachedEvaluator.metrics(),
  });
}

function bestRootMove(
  scores: readonly IterativeRootMoveScore[],
): IterativeRootMoveScore {
  const selected = [...scores].sort((left, right) =>
    right.score - left.score
    || moveId(left.move).localeCompare(moveId(right.move))
  )[0];
  if (selected === undefined) {
    throw new Error("Completed player-private iteration has no root scores.");
  }
  return selected;
}

function orderedRootMoves(
  moves: readonly ChessMove[],
): readonly ChessMove[] {
  return Object.freeze(
    [...moves].sort((left, right) =>
      moveId(left).localeCompare(moveId(right))
    ),
  );
}

function moveId(
  move: Pick<ChessMove, "from" | "to" | "promotion">,
): string {
  return `${move.from}${move.to}${move.promotion?.[0] ?? ""}`;
}

function validateLimits(limits: IterativePlayerPrivateSearchLimits): void {
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth <= 0) {
    throw new RangeError(
      "Iterative player-private search maxDepth must be a positive safe integer.",
    );
  }
  if (!Number.isSafeInteger(limits.maxNodes) || limits.maxNodes <= 1) {
    throw new RangeError(
      "Iterative player-private search maxNodes must be an integer greater than one.",
    );
  }
  if (
    limits.leafCacheEntries !== undefined
    && (
      !Number.isSafeInteger(limits.leafCacheEntries)
      || limits.leafCacheEntries <= 0
    )
  ) {
    throw new RangeError(
      "Iterative player-private search leafCacheEntries must be a positive safe integer.",
    );
  }
  if (
    limits.leafCacheHistoryMode !== undefined
    && !CACHE_HISTORY_MODES.has(limits.leafCacheHistoryMode)
  ) {
    throw new RangeError(
      "Iterative player-private search leafCacheHistoryMode must be full or ignore.",
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException(
      "Iterative player-private search was aborted.",
      "AbortError",
    );
  }
}
