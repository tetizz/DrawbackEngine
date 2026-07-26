import {
  publicGameTraceView,
  type PublicGameTrace,
} from "@drawbackengine/chess-core";
import type { ChessMove } from "@drawbackengine/drawback-engine";
import {
  DEFAULT_PLAYER_PRIVATE_LEAF_CACHE_ENTRIES,
  selectIterativePlayerPrivateDrawbackMove,
  type DrawbackLeafEvaluator,
  type IterativePlayerPrivateMoveSelection,
  type IterativePlayerPrivateSearchLimits,
  type OwnPlayerRuleCapability,
  type PlayerPrivateOpponentAggregation,
  type PublicDrawbackHypothesis,
  type RootTemperatureSelectionOptions,
} from "@drawbackengine/drawback-search";
import type {
  PlayerColor,
  RandomSource,
} from "@drawbackengine/shared";

const OPPONENT_AGGREGATIONS: ReadonlySet<string> = new Set([
  "worst-case",
  "posterior-expected",
]);

export interface PlayerPrivateAgentView {
  readonly color: PlayerColor;
  readonly ply: number;
  readonly legalMoves: readonly ChessMove[];
  readonly trace: PublicGameTrace;
  readonly own: OwnPlayerRuleCapability;
  readonly opponent: readonly PublicDrawbackHypothesis[];
}

export interface PlayerPrivateSimulationAgent {
  readonly id: string;
  readonly style?: string;
  readonly strength?: number;
  readonly searchPolicy?: PlayerPrivateAgentSearchPolicy;
  chooseMove(
    view: PlayerPrivateAgentView,
    rng: RandomSource,
  ): Promise<ChessMove>;
}

export interface PlayerPrivateAgentSearchPolicy {
  readonly policyId: string;
  readonly evaluatorId: string;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly leafCacheEntries: number | null;
  readonly leafCacheHistoryMode: "full" | "ignore";
  readonly opponentAggregation?: PlayerPrivateOpponentAggregation;
  readonly temperatureCp: number;
  readonly topK: number | null;
}

export interface PlayerPrivateSearchAgentOptions {
  readonly id: string;
  readonly policyId?: string;
  readonly evaluator: DrawbackLeafEvaluator;
  readonly limits: IterativePlayerPrivateSearchLimits;
  readonly opponentAggregation?: PlayerPrivateOpponentAggregation;
  readonly temperature: RootTemperatureSelectionOptions;
  readonly strength?: number;
}

export function createPlayerPrivateSearchAgent(
  options: PlayerPrivateSearchAgentOptions,
): PlayerPrivateSimulationAgent {
  if (options.id.trim().length === 0) {
    throw new RangeError("Player-private search agent ID must not be empty.");
  }
  if (options.id !== options.id.trim() || /[\r\n]/u.test(options.id)) {
    throw new RangeError(
      "Player-private search agent ID must be trimmed and single-line.",
    );
  }
  const policyId = options.policyId ?? options.id;
  if (
    policyId.trim().length === 0
    || policyId !== policyId.trim()
    || /[\r\n]/u.test(policyId)
  ) {
    throw new RangeError(
      "Player-private search policy ID must be trimmed and single-line.",
    );
  }
  const evaluator = Object.freeze({
    id: options.evaluator.id,
    evaluate: options.evaluator.evaluate.bind(options.evaluator),
  });
  const limits = Object.freeze({
    maxDepth: options.limits.maxDepth,
    maxNodes: options.limits.maxNodes,
    ...(options.limits.leafCacheEntries === undefined
      ? {}
      : { leafCacheEntries: options.limits.leafCacheEntries }),
    ...(options.limits.leafCacheHistoryMode === undefined
      ? {}
      : { leafCacheHistoryMode: options.limits.leafCacheHistoryMode }),
    ...(options.limits.signal === undefined
      ? {}
      : { signal: options.limits.signal }),
  });
  const temperature = Object.freeze({
    temperatureCp: options.temperature.temperatureCp,
    ...(options.temperature.topK === undefined
      ? {}
      : { topK: options.temperature.topK }),
  });
  const opponentAggregation =
    options.opponentAggregation ?? "worst-case";
  if (!OPPONENT_AGGREGATIONS.has(opponentAggregation)) {
    throw new RangeError(
      "Opponent aggregation must be worst-case or posterior-expected.",
    );
  }
  validateSnapshottedOptions(evaluator.id, limits, temperature);
  return Object.freeze({
    id: options.id,
    style: "drawback-search",
    ...(options.strength === undefined
      ? {}
      : { strength: options.strength }),
    searchPolicy: Object.freeze({
      policyId,
      evaluatorId: evaluator.id,
      maxDepth: limits.maxDepth,
      maxNodes: limits.maxNodes,
      leafCacheEntries:
        limits.leafCacheEntries
        ?? DEFAULT_PLAYER_PRIVATE_LEAF_CACHE_ENTRIES,
      leafCacheHistoryMode:
        limits.leafCacheHistoryMode ?? "full",
      opponentAggregation,
      temperatureCp: temperature.temperatureCp,
      topK: temperature.topK ?? null,
    }),
    async chooseMove(
      view: PlayerPrivateAgentView,
      rng: RandomSource,
    ) {
      let selected: IterativePlayerPrivateMoveSelection;
      try {
        selected = await selectIterativePlayerPrivateDrawbackMove(
          {
            trace: view.trace,
            own: view.own,
            opponent: view.opponent,
            aggregation: opponentAggregation,
          },
          evaluator,
          limits,
          rng,
          temperature,
          view.legalMoves,
        );
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown search failure.";
        throw new Error(
          `Player-private search failed at ply ${String(view.ply)} `
            + `for ${view.color} in ${publicGameTraceView(view.trace).fen}: `
            + message,
          { cause: error },
        );
      }
      const exactMove = view.legalMoves.find((move: ChessMove) =>
        sameMove(move, selected.move)
      );
      if (exactMove === undefined) {
        throw new Error(
          "Player-private search selected a move outside the coordinator legal mask.",
        );
      }
      return Object.freeze(structuredClone(exactMove));
    },
  });
}

function validateSnapshottedOptions(
  evaluatorId: string,
  limits: IterativePlayerPrivateSearchLimits,
  temperature: RootTemperatureSelectionOptions,
): void {
  if (
    evaluatorId.trim().length === 0
    || evaluatorId !== evaluatorId.trim()
    || /[\r\n]/u.test(evaluatorId)
  ) {
    throw new RangeError("Evaluator ID must be trimmed and single-line.");
  }
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth <= 0) {
    throw new RangeError("Search maxDepth must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(limits.maxNodes) || limits.maxNodes <= 1) {
    throw new RangeError(
      "Search maxNodes must be a safe integer greater than one.",
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
      "Search leafCacheEntries must be a positive safe integer.",
    );
  }
  const historyMode: string | undefined =
    limits.leafCacheHistoryMode;
  if (
    historyMode !== undefined
    && historyMode !== "full"
    && historyMode !== "ignore"
  ) {
    throw new RangeError(
      "Search leafCacheHistoryMode must be full or ignore.",
    );
  }
  if (
    !Number.isFinite(temperature.temperatureCp)
    || temperature.temperatureCp <= 0
  ) {
    throw new RangeError(
      "Search temperatureCp must be finite and positive.",
    );
  }
  if (
    temperature.topK !== undefined
    && (
      !Number.isSafeInteger(temperature.topK)
      || temperature.topK <= 0
    )
  ) {
    throw new RangeError("Search topK must be a positive safe integer.");
  }
}

function sameMove(
  left: Pick<ChessMove, "from" | "to" | "promotion">,
  right: Pick<ChessMove, "from" | "to" | "promotion">,
): boolean {
  return (
    left.from === right.from
    && left.to === right.to
    && left.promotion === right.promotion
  );
}
