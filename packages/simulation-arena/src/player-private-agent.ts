import type { PublicGameTrace } from "@drawbackengine/chess-core";
import type { ChessMove } from "@drawbackengine/drawback-engine";
import {
  DEFAULT_PLAYER_PRIVATE_LEAF_CACHE_ENTRIES,
  selectIterativePlayerPrivateDrawbackMove,
  type DrawbackLeafEvaluator,
  type IterativePlayerPrivateSearchLimits,
  type OwnPlayerRuleCapability,
  type PublicDrawbackHypothesis,
  type RootTemperatureSelectionOptions,
} from "@drawbackengine/drawback-search";
import type {
  PlayerColor,
  RandomSource,
} from "@drawbackengine/shared";

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
  readonly temperatureCp: number;
  readonly topK: number | null;
}

export interface PlayerPrivateSearchAgentOptions {
  readonly id: string;
  readonly policyId?: string;
  readonly evaluator: DrawbackLeafEvaluator;
  readonly limits: IterativePlayerPrivateSearchLimits;
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
      temperatureCp: temperature.temperatureCp,
      topK: temperature.topK ?? null,
    }),
    async chooseMove(
      view: PlayerPrivateAgentView,
      rng: RandomSource,
    ) {
      const selected = await selectIterativePlayerPrivateDrawbackMove(
        {
          trace: view.trace,
          own: view.own,
          opponent: view.opponent,
          aggregation: "worst-case",
        },
        evaluator,
        limits,
        rng,
        temperature,
        view.legalMoves,
      );
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
