import type { ChessMove } from "@drawbackengine/drawback-engine";
import type { RandomSource } from "@drawbackengine/shared";
import {
  searchIterativePlayerPrivateDrawbackMove,
  type IterativePlayerPrivateSearchLimits,
  type IterativePlayerPrivateSearchResult,
  type PlayerPrivateSearchContext,
} from "./player-private-iterative-search.js";
import {
  selectRootMoveByTemperature,
  type RootTemperatureSelection,
  type RootTemperatureSelectionOptions,
} from "./root-temperature-selector.js";
import type { DrawbackLeafEvaluator } from "./types.js";

export interface IterativePlayerPrivateMoveSelection {
  readonly move: ChessMove;
  readonly search: IterativePlayerPrivateSearchResult;
  readonly temperature: RootTemperatureSelection;
}

/**
 * Searches first, then samples only from the deepest fully completed root set.
 *
 * Incomplete iterations are already discarded by the iterative search. The
 * selector consumes exactly one gameplay RNG sample after successful search.
 */
export async function selectIterativePlayerPrivateDrawbackMove(
  input: PlayerPrivateSearchContext,
  evaluator: DrawbackLeafEvaluator,
  limits: IterativePlayerPrivateSearchLimits,
  rng: RandomSource,
  temperature: RootTemperatureSelectionOptions,
  expectedRootMoves?: readonly ChessMove[],
): Promise<IterativePlayerPrivateMoveSelection> {
  const search = await searchIterativePlayerPrivateDrawbackMove(
    input,
    evaluator,
    limits,
  );
  if (expectedRootMoves !== undefined) {
    assertExactRootSet(search.rootMoves, expectedRootMoves);
  }
  const selection = selectRootMoveByTemperature(
    search.rootMoves,
    rng,
    {
      ...temperature,
      ...(temperature.topK === undefined
        ? {}
        : { topK: Math.min(temperature.topK, search.rootMoves.length) }),
    },
  );
  return Object.freeze({
    move: Object.freeze(structuredClone(selection.move)),
    search,
    temperature: selection,
  });
}

function assertExactRootSet(
  scored: IterativePlayerPrivateSearchResult["rootMoves"],
  expected: readonly ChessMove[],
): void {
  const scoredIds = scored.map(({ move }) => moveId(move)).sort();
  const expectedIds = expected.map(moveId).sort();
  if (
    scoredIds.length !== expectedIds.length
    || scoredIds.some((id, index) => id !== expectedIds[index])
  ) {
    const scoredSet = new Set(scoredIds);
    const expectedSet = new Set(expectedIds);
    const missing = expectedIds.filter((id) => !scoredSet.has(id));
    const unexpected = scoredIds.filter((id) => !expectedSet.has(id));
    throw new Error(
      "Player-private search roots do not equal the coordinator legal mask. "
        + `Missing: ${missing.join(",") || "none"}. `
        + `Unexpected: ${unexpected.join(",") || "none"}.`,
    );
  }
}

function moveId(
  move: Pick<ChessMove, "from" | "to" | "promotion">,
): string {
  return `${move.from}${move.to}${move.promotion?.[0] ?? ""}`;
}
