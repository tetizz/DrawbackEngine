import { opposite, type PlayerColor } from "@drawbackengine/shared";
import {
  isInCheck,
  parseFenPieces,
} from "../board-analysis.js";
import type {
  ChessMove,
  DrawbackRule,
  PieceType,
  RuleEvidence,
  RuleInitializationContext,
} from "../types.js";
import type {
  NoParameters,
  StatelessRuleState,
} from "./common.js";
import { filterIrresistibleMoves } from "./geometric-observed-rules.js";
import { parseExactParameterObject } from "./runtime-boundaries.js";

const CAPTURABLE_KING_AUTHORITY = ["capturable-king/v1"] as const;

function isKingCapture(move: ChessMove): boolean {
  return move.captured === "king";
}

function ownMovesApplied(
  history: readonly ChessMove[],
  color: PlayerColor,
): number {
  return history.filter((move) => move.color === color).length;
}

function parseNoParameters(input: unknown, ruleName: string): NoParameters {
  parseExactParameterObject(input, [], `${ruleName} parameters`);
  return {};
}

function initializeStateless<Parameters>(
  context: RuleInitializationContext<Parameters>,
): StatelessRuleState {
  return {
    movesApplied: ownMovesApplied(context.position.history, context.color),
  };
}

function kingCaptureRejection(
  ruleId: string,
  message: string,
  move: ChessMove,
): readonly RuleEvidence[] {
  return isKingCapture(move)
    ? [{
        ruleId,
        kind: "eliminated",
        message,
        move,
      }]
    : [];
}

export const femmeFataleRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "femme-fatale",
  name: "Femme Fatale",
  description:
    "The affected player may capture the opposing king only with a primary queen mover.",
  verification: "implemented-unverified",
  supportedAuthorities: CAPTURABLE_KING_AUTHORITY,
  generateParameters: () => ({}),
  validateParameters: (input) => parseNoParameters(input, "Femme Fatale"),
  initialize: initializeStateless,
  filterLegalMoves: (_context, moves) =>
    moves.filter(
      (move) => !isKingCapture(move) || move.piece === "queen",
    ),
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
  explainMove: (_context, move) =>
    move.piece === "queen"
      ? []
      : kingCaptureRejection(
          "femme-fatale",
          `${move.san} cannot capture the opposing king because its primary mover is not a queen.`,
          move,
        ),
};

export interface NurturerState {
  readonly movesApplied: number;
  readonly hasPromotedPawn: boolean;
}

function initializeNurturer(
  context: RuleInitializationContext<NoParameters>,
): NurturerState {
  return {
    movesApplied: ownMovesApplied(context.position.history, context.color),
    hasPromotedPawn: context.position.history.some(
      (move) => isOwnPromotion(move, context.color),
    ),
  };
}

function isOwnPromotion(move: ChessMove, color: PlayerColor): boolean {
  return (
    move.color === color &&
    move.piece === "pawn" &&
    move.promotion !== undefined
  );
}

export const nurturerRule: DrawbackRule<NurturerState, NoParameters> = {
  id: "nurturer",
  name: "Nurturer",
  description:
    "The affected player may not capture the opposing king until one of their pawns has completed a promotion.",
  verification: "implemented-unverified",
  supportedAuthorities: CAPTURABLE_KING_AUTHORITY,
  generateParameters: () => ({}),
  validateParameters: (input) => parseNoParameters(input, "Nurturer"),
  initialize: initializeNurturer,
  filterLegalMoves: (context, moves) =>
    context.state.hasPromotedPawn
      ? [...moves]
      : moves.filter((move) => !isKingCapture(move)),
  applyMove: (context, move) => ({
    movesApplied: context.state.movesApplied + 1,
    hasPromotedPawn:
      context.state.hasPromotedPawn ||
      isOwnPromotion(move, context.color),
  }),
  checkStartOfTurnLoss: () => null,
  explainMove: (context, move) =>
    context.state.hasPromotedPawn
      ? []
      : kingCaptureRejection(
          "nurturer",
          `${move.san} cannot capture the opposing king before an affected pawn has completed a promotion.`,
          move,
        ),
};

export const OBSERVED_TRIPLE_PLAY_TYPES = [
  "bishop",
  "knight",
] as const satisfies readonly PieceType[];

export type TriplePlayPieceType =
  (typeof OBSERVED_TRIPLE_PLAY_TYPES)[number];

export interface TriplePlayParameters extends Record<string, unknown> {
  readonly requiredType: TriplePlayPieceType;
}

function requiredTypeCount(
  fen: string,
  color: PlayerColor,
  requiredType: TriplePlayPieceType,
): number {
  return parseFenPieces(fen).filter(
    (piece) =>
      piece.color === color &&
      piece.type === requiredType,
  ).length;
}

function parseTriplePlayParameters(input: unknown): TriplePlayParameters {
  const parsed = parseExactParameterObject(
    input,
    ["requiredType"],
    "Triple Play parameters",
  );
  const requiredType = parsed["requiredType"];
  if (requiredType !== "bishop" && requiredType !== "knight") {
    throw new RangeError(
      "Triple Play parameters.requiredType must be bishop or knight.",
    );
  }
  return { requiredType };
}

export const triplePlayRule: DrawbackRule<
  StatelessRuleState,
  TriplePlayParameters
> = {
  id: "triple-play",
  name: "Triple Play",
  description:
    "The affected player may capture the opposing king only while owning at least three pieces of one hidden observed type.",
  verification: "implemented-unverified",
  supportedAuthorities: CAPTURABLE_KING_AUTHORITY,
  generateParameters: (rng) => {
    const requiredType =
      OBSERVED_TRIPLE_PLAY_TYPES[
        rng.integer(OBSERVED_TRIPLE_PLAY_TYPES.length)
      ];
    if (requiredType === undefined) {
      throw new RangeError(
        "Random source returned an invalid Triple Play piece-type index.",
      );
    }
    return { requiredType };
  },
  validateParameters: parseTriplePlayParameters,
  initialize: initializeStateless,
  filterLegalMoves: (context, moves) => {
    const thresholdMet =
      requiredTypeCount(
        context.position.fen,
        context.color,
        context.parameters.requiredType,
      ) >= 3;
    return thresholdMet
      ? [...moves]
      : moves.filter((move) => !isKingCapture(move));
  },
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
  explainMove: (context, move) => {
    const count = requiredTypeCount(
      context.position.fen,
      context.color,
      context.parameters.requiredType,
    );
    return count >= 3
      ? []
      : kingCaptureRejection(
          "triple-play",
          `${move.san} cannot capture the opposing king while the affected player owns only ${String(count)} ${context.parameters.requiredType}${count === 1 ? "" : "s"}.`,
          move,
        );
  },
};

/**
 * Authority-complete Irresistible runtime.
 *
 * The standard-authority irresistibleRule remains partial because orthodox
 * move generation cannot produce the observed literal king-capture exception.
 */
export const capturableKingIrresistibleRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "irresistible",
  name: "Irresistible",
  description:
    "If possible, the affected player must move a previously non-adjacent piece adjacent to the opponent king, but may always capture that king.",
  verification: "implemented-unverified",
  supportedAuthorities: CAPTURABLE_KING_AUTHORITY,
  generateParameters: () => ({}),
  validateParameters: (input) => parseNoParameters(input, "Irresistible"),
  initialize: initializeStateless,
  filterLegalMoves: (context, moves) =>
    filterIrresistibleMoves(
      context.color,
      moves,
      parseFenPieces(context.position.fen),
    ),
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
};

export interface YouBestNotMissState {
  readonly movesApplied: number;
  readonly mustCaptureKingNextTurn: boolean;
}

function moveLeavesOpponentInCheck(
  color: PlayerColor,
  move: ChessMove,
  fenAfterMove: string,
): boolean {
  // Literal king capture is already terminal and has no opposing king left to
  // test. DrawbackGameSession gives this terminal event precedence.
  return (
    !isKingCapture(move) &&
    isInCheck(fenAfterMove, opposite(color))
  );
}

function initializeYouBestNotMiss(
  context: RuleInitializationContext<NoParameters>,
): YouBestNotMissState {
  return {
    movesApplied: ownMovesApplied(context.position.history, context.color),
    mustCaptureKingNextTurn: false,
  };
}

export const youBestNotMissRule: DrawbackRule<
  YouBestNotMissState,
  NoParameters
> = {
  id: "you-best-not-miss",
  name: "You Best Not Miss",
  description:
    "After ending an affected turn checking the opponent, the affected player's next move must capture the opposing king or they lose.",
  verification: "implemented-unverified",
  supportedAuthorities: CAPTURABLE_KING_AUTHORITY,
  generateParameters: () => ({}),
  validateParameters: (input) =>
    parseNoParameters(input, "You Best Not Miss"),
  initialize: initializeYouBestNotMiss,
  filterLegalMoves: (context, moves) =>
    context.state.mustCaptureKingNextTurn
      ? moves.filter(isKingCapture)
      : [...moves],
  applyMove: (context, move) => ({
    movesApplied: context.state.movesApplied + 1,
    mustCaptureKingNextTurn: moveLeavesOpponentInCheck(
      context.color,
      move,
      context.positionAfterMove.fen,
    ),
  }),
  // When an obligation has no authority-generated king capture, the shared
  // session's immutable filter produces an empty mask and adjudicates the
  // start-of-turn drawback loss. RuleLossContext intentionally has no move
  // authority snapshot, so duplicating that calculation here would mishandle
  // the authority's castling-en-passant king-capture right.
  checkStartOfTurnLoss: () => null,
  explainMove: (context, move) =>
    context.state.mustCaptureKingNextTurn && !isKingCapture(move)
      ? [{
          ruleId: "you-best-not-miss",
          kind: "eliminated",
          message:
            `${move.san} declines the required opposing-king capture after the affected player's previous check.`,
          move,
        }]
      : [],
};

function eraseRule<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
): DrawbackRule<unknown, unknown> {
  return rule;
}

/**
 * Capturable-king-only v3 registry.
 *
 * These authority-scoped objects deliberately do not enter the frozen
 * standard-authority v2 executable catalog. Irresistible has a distinct
 * partial object in that catalog under the same canonical ID; the other IDs
 * remain absent. Standard chess cannot exercise their king-capture semantics.
 */
export const capturableKingRules: readonly DrawbackRule<
  unknown,
  unknown
>[] = Object.freeze([
  eraseRule(femmeFataleRule),
  eraseRule(nurturerRule),
  eraseRule(triplePlayRule),
  eraseRule(youBestNotMissRule),
  eraseRule(capturableKingIrresistibleRule),
]);

const capturableKingRulesById = new Map(
  capturableKingRules.map((rule) => [rule.id, rule]),
);

if (capturableKingRulesById.size !== capturableKingRules.length) {
  throw new Error("Capturable-king drawback rule IDs must be unique.");
}

export function resolveCapturableKingRule(
  id: string,
): DrawbackRule<unknown, unknown> {
  const rule = capturableKingRulesById.get(id);
  if (rule === undefined) {
    throw new RangeError(`Unknown capturable-king drawback rule: ${id}.`);
  }
  return rule;
}
