import type { ChessMove, DrawbackRule } from "../types.js";
import {
  defineMoveFilterRule,
  isDarkSquare,
  squareCoordinates,
  travelDistance,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

const STANDARD_AND_CAPTURABLE_AUTHORITIES = [
  "standard-chess/v1",
  "capturable-king/v1",
] as const;

function isLateral(move: ChessMove): boolean {
  return squareCoordinates(move.from).rank === squareCoordinates(move.to).rank;
}

function defineForbiddenDestinationRule(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly forbidden: (move: ChessMove) => boolean;
  readonly reason: string;
  readonly supportedAuthorities?: DrawbackRule<
    StatelessRuleState,
    NoParameters
  >["supportedAuthorities"];
}): DrawbackRule<StatelessRuleState, NoParameters> {
  return defineMoveFilterRule({
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    ...(configuration.supportedAuthorities === undefined
      ? {}
      : { supportedAuthorities: configuration.supportedAuthorities }),
    permits: (move) => !configuration.forbidden(move),
    rejection: (move) => `${move.san} ${configuration.reason}`,
  });
}

function defineMaximumTravelRule(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly piece: ChessMove["piece"];
  readonly maximum: number;
}): DrawbackRule<StatelessRuleState, NoParameters> {
  return defineMoveFilterRule({
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    permits: (move) =>
      move.piece !== configuration.piece ||
      travelDistance(move) <= configuration.maximum,
    rejection: (move) =>
      `${move.san} moves a ${configuration.piece} more than ` +
      `${String(configuration.maximum)} squares.`,
  });
}

function defineForbiddenLateralRule(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly appliesTo: (move: ChessMove) => boolean;
  readonly supportedAuthorities?: DrawbackRule<
    StatelessRuleState,
    NoParameters
  >["supportedAuthorities"];
}): DrawbackRule<StatelessRuleState, NoParameters> {
  return defineMoveFilterRule({
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    ...(configuration.supportedAuthorities === undefined
      ? {}
      : { supportedAuthorities: configuration.supportedAuthorities }),
    permits: (move) => !configuration.appliesTo(move) || !isLateral(move),
    rejection: (move) => `${move.san} is a forbidden lateral move.`,
  });
}

export const numberOfTheBeastRule = defineForbiddenDestinationRule({
  id: "number-of-the-beast",
  name: "Number of the Beast",
  description: "The primary mover cannot move to the sixth rank.",
  forbidden: (move) => squareCoordinates(move.to).rank === 6,
  reason: "ends on the forbidden sixth rank.",
});

export const shadowQueenRule = defineForbiddenDestinationRule({
  id: "shadow-queen",
  name: "Shadow Queen",
  description: "The player's queen can move only to dark squares.",
  supportedAuthorities: STANDARD_AND_CAPTURABLE_AUTHORITIES,
  forbidden: (move) => move.piece === "queen" && !isDarkSquare(move.to),
  reason: "moves the queen to a light square.",
});

export const entrenchedRule = defineMaximumTravelRule({
  id: "entrenched",
  name: "Entrenched",
  description: "The player's rooks cannot move more than two squares.",
  piece: "rook",
  maximum: 2,
});

export const noShufflingRule = defineForbiddenLateralRule({
  id: "no-shuffling",
  name: "No Shuffling",
  description: "The player's rooks cannot move sideways.",
  appliesTo: (move) => move.piece === "rook",
});

export const stopStallingRule = defineForbiddenLateralRule({
  id: "stop-stalling",
  name: "Stop Stalling",
  description: "The player's primary pieces cannot move laterally.",
  supportedAuthorities: STANDARD_AND_CAPTURABLE_AUTHORITIES,
  appliesTo: () => true,
});

export const expandedRules = [
  numberOfTheBeastRule,
  shadowQueenRule,
  entrenchedRule,
  noShufflingRule,
  stopStallingRule,
] as const;
