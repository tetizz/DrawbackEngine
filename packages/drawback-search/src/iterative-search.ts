import type { DrawbackGameSession } from "@drawbackengine/chess-core";
import type { ChessMove } from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";
import {
  createCachingLeafEvaluator,
  type LeafEvaluationCacheMetrics,
} from "./caching-leaf-evaluator.js";
import { searchOmniscientDrawbackRootMove } from "./search.js";
import type {
  DrawbackLeafEvaluator,
  DrawbackSearchResult,
} from "./types.js";

type OmniscientSession = DrawbackGameSession<
  unknown,
  unknown,
  unknown,
  unknown
>;

export interface IterativeDrawbackSearchLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly leafCacheEntries?: number;
  readonly leafCacheHistoryMode?: "full" | "ignore";
  readonly signal?: AbortSignal;
}

export type IterativeSearchStopReason =
  | "target-depth"
  | "node-budget";

export interface IterativeRootMoveScore {
  readonly move: ChessMove;
  readonly score: number;
  readonly principalVariation: readonly ChessMove[];
}

export interface IterativeDrawbackSearchResult {
  readonly move: DrawbackSearchResult["move"];
  readonly score: number;
  readonly principalVariation: DrawbackSearchResult["principalVariation"];
  /** Total nodes spent across all attempted depth iterations. */
  readonly nodes: number;
  /** Total requested leaf visits across all attempted depth iterations. */
  readonly leaves: number;
  /** True when maxDepth was not completed. The returned move is never partial. */
  readonly truncated: boolean;
  readonly rootColor: PlayerColor;
  readonly evaluatorId: string;
  readonly knowledgeMode: "omniscient-oracle";
  readonly requestedDepth: number;
  readonly completedDepth: number;
  readonly stopReason: IterativeSearchStopReason;
  /** Exact full-window scores from the deepest completed iteration. */
  readonly rootMoves: readonly IterativeRootMoveScore[];
  readonly leafCache: LeafEvaluationCacheMetrics;
}

export class IncompleteDrawbackSearchError extends Error {
  public readonly attemptedDepth: number;
  public readonly maxNodes: number;

  public constructor(attemptedDepth: number, maxNodes: number) {
    super(
      `Drawback search could not complete depth ${String(attemptedDepth)} within ${String(maxNodes)} nodes.`,
    );
    this.name = "IncompleteDrawbackSearchError";
    this.attemptedDepth = attemptedDepth;
    this.maxNodes = maxNodes;
  }
}

/**
 * Iterative-deepening production wrapper around the exact omniscient tree.
 *
 * A node-limited partial iteration is discarded. The caller either receives
 * the best move from the deepest fully completed iteration or a typed error
 * when even depth one cannot be completed.
 */
export async function searchIterativeOmniscientDrawbackMove(
  session: OmniscientSession,
  evaluator: DrawbackLeafEvaluator,
  limits: IterativeDrawbackSearchLimits,
): Promise<IterativeDrawbackSearchResult> {
  validateLimits(limits);
  throwIfAborted(limits.signal);
  const cachedEvaluator = createCachingLeafEvaluator({
    evaluator,
    maxEntries: limits.leafCacheEntries ?? 16_384,
    historyMode: limits.leafCacheHistoryMode ?? "full",
  });
  let nodes = 0;
  let leaves = 0;
  let completed: DrawbackSearchResult | null = null;
  let completedRootMoves: readonly IterativeRootMoveScore[] = [];
  let completedDepth = 0;
  const rootMoves = orderedRootMoves(session.legalMoves());

  for (let depth = 1; depth <= limits.maxDepth; depth += 1) {
    throwIfAborted(limits.signal);
    const iteration: IterativeRootMoveScore[] = [];
    let iterationIncomplete = false;
    for (const rootMove of rootMoves) {
      const remaining = limits.maxNodes - nodes;
      if (remaining <= 1) {
        iterationIncomplete = true;
        break;
      }
      const rootResult = await searchOmniscientDrawbackRootMove(
        session,
        rootMove,
        cachedEvaluator,
        {
          depth,
          maxNodes: remaining,
          ...(limits.signal === undefined ? {} : { signal: limits.signal }),
        },
      );
      nodes += rootResult.nodes;
      leaves += rootResult.leaves;
      if (rootResult.truncated) {
        iterationIncomplete = true;
        break;
      }
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
    const selected = bestRootMove(iteration);
    completed = {
      move: selected.move,
      score: selected.score,
      principalVariation: selected.principalVariation,
      nodes,
      leaves,
      truncated: false,
      rootColor: session.turn,
      evaluatorId: evaluator.id,
      knowledgeMode: "omniscient-oracle",
    };
    completedRootMoves = Object.freeze(iteration);
    completedDepth = depth;
  }

  if (completed === null) {
    throw new IncompleteDrawbackSearchError(1, limits.maxNodes);
  }
  const reachedTarget = completedDepth === limits.maxDepth;
  return Object.freeze({
    move: structuredClone(completed.move),
    score: completed.score,
    principalVariation: Object.freeze(
      structuredClone(completed.principalVariation),
    ),
    nodes,
    leaves,
    truncated: !reachedTarget,
    rootColor: completed.rootColor,
    evaluatorId: evaluator.id,
    knowledgeMode: "omniscient-oracle",
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
    throw new Error("Completed drawback iteration has no root scores.");
  }
  return selected;
}

function orderedRootMoves(moves: readonly ChessMove[]): readonly ChessMove[] {
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

function validateLimits(limits: IterativeDrawbackSearchLimits): void {
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth <= 0) {
    throw new RangeError(
      "Iterative drawback search maxDepth must be a positive safe integer.",
    );
  }
  if (!Number.isSafeInteger(limits.maxNodes) || limits.maxNodes <= 1) {
    throw new RangeError(
      "Iterative drawback search maxNodes must be an integer greater than one.",
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
      "Iterative drawback search leafCacheEntries must be a positive safe integer.",
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException(
      "Iterative drawback search was aborted.",
      "AbortError",
    );
  }
}
