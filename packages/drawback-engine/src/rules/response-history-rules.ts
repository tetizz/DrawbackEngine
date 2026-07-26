import type { PlayerColor } from "@drawbackengine/shared";
import type {
  ChessMove,
  DrawbackRule,
  RuleMoveContext,
} from "../types.js";
import {
  areAdjacent,
} from "../board-analysis.js";
import {
  isCapture,
  isDarkSquare,
  manhattanDistance,
  squareCoordinates,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

interface ResponseFilterConfiguration {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly filter: (
    context: RuleMoveContext<StatelessRuleState, NoParameters>,
    moves: readonly ChessMove[],
  ) => readonly ChessMove[];
}

function defineResponseFilter(
  configuration: ResponseFilterConfiguration,
): DrawbackRule<StatelessRuleState, NoParameters> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    verification: "implemented-unverified",
    generateParameters: () => ({}),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (context, moves) => [
      ...configuration.filter(context, moves),
    ],
    applyMove: (context) => ({
      movesApplied: context.state.movesApplied + 1,
    }),
    checkStartOfTurnLoss: () => null,
  };
}

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function movesBy(
  context: RuleMoveContext<StatelessRuleState, NoParameters>,
  color: PlayerColor,
): readonly ChessMove[] {
  return context.position.history.filter((move) => move.color === color);
}

function lastMoveBy(
  context: RuleMoveContext<StatelessRuleState, NoParameters>,
  color: PlayerColor,
): ChessMove | undefined {
  return [...context.position.history].reverse()
    .find((move) => move.color === color);
}

function forceWhenAvailable(
  ordinary: readonly ChessMove[],
  predicate: (move: ChessMove) => boolean,
): readonly ChessMove[] {
  const forced = ordinary.filter(predicate);
  return forced.length === 0 ? ordinary : forced;
}

function isBackward(move: ChessMove): boolean {
  const fromRank = squareCoordinates(move.from).rank;
  const toRank = squareCoordinates(move.to).rank;
  return move.color === "white" ? toRank < fromRank : toRank > fromRank;
}

export const boxingWithShadowRule = defineResponseFilter({
  id: "boxing-with-shadow",
  name: "Boxing with Shadow",
  description:
    "If possible, the affected player must move to the origin square of the opponent's previous primary move.",
  filter: (context, moves) => {
    const previous = lastMoveBy(context, opposite(context.color));
    return previous === undefined
      ? moves
      : forceWhenAvailable(moves, ({ to }) => to === previous.from);
  },
});

export const cowardlyRule = defineResponseFilter({
  id: "cowardly",
  name: "Cowardly",
  description:
    "After the opponent captures, every legal response must move backward relative to the affected player's color.",
  filter: (context, moves) => {
    const previous = lastMoveBy(context, opposite(context.color));
    return previous === undefined || !isCapture(previous)
      ? moves
      : moves.filter(isBackward);
  },
});

export const goingTheDistanceRule = defineResponseFilter({
  id: "going-the-distance",
  name: "Going the Distance",
  description:
    "A move's Manhattan distance must be at least the Manhattan distance of the opponent's previous move.",
  filter: (context, moves) => {
    const previous = lastMoveBy(context, opposite(context.color));
    if (previous === undefined) {
      return moves;
    }
    const minimum = manhattanDistance(previous);
    return moves.filter((move) => manhattanDistance(move) >= minimum);
  },
});

export const leftToRightRule = defineResponseFilter({
  id: "left-to-right",
  name: "Left to Right",
  description:
    "After the first move, destinations must progress to a file right of the affected player's previous destination, unless that destination was the h-file.",
  filter: (context, moves) => {
    const previous = lastMoveBy(context, context.color);
    if (previous === undefined || previous.to.startsWith("h")) {
      return moves;
    }
    const previousFile = squareCoordinates(previous.to).file;
    return moves.filter(
      (move) => squareCoordinates(move.to).file > previousFile,
    );
  },
});

export const relayRaceRule = defineResponseFilter({
  id: "relay-race",
  name: "Relay Race",
  description:
    "If possible, the affected player must move a piece whose origin is adjacent to their previous destination.",
  filter: (context, moves) => {
    const previous = lastMoveBy(context, context.color);
    return previous === undefined
      ? moves
      : forceWhenAvailable(
          moves,
          ({ from }) => areAdjacent(from, previous.to),
        );
  },
});

export const religiousDisputeRule = defineResponseFilter({
  id: "religious-dispute",
  name: "Religious Dispute",
  description:
    "After the opponent moves a bishop, the affected player's next primary mover must be a bishop.",
  filter: (context, moves) => {
    const previous = lastMoveBy(context, opposite(context.color));
    return previous?.piece === "bishop"
      ? moves.filter(({ piece }) => piece === "bishop")
      : moves;
  },
});

export const simonSaysRule = defineResponseFilter({
  id: "simon-says",
  name: "Simon Says",
  description:
    "The affected player's destination must have the same square color as the opponent's previous destination.",
  filter: (context, moves) => {
    const previous = lastMoveBy(context, opposite(context.color));
    return previous === undefined
      ? moves
      : moves.filter(
          ({ to }) => isDarkSquare(to) === isDarkSquare(previous.to),
        );
  },
});

export const superstitiousRule = defineResponseFilter({
  id: "superstitious",
  name: "Superstitious",
  description:
    "The affected player cannot move to any destination where the opponent previously made a capture.",
  filter: (context, moves) => {
    const cursed = new Set(
      movesBy(context, opposite(context.color))
        .filter(isCapture)
        .map(({ to }) => to),
    );
    return moves.filter(({ to }) => !cursed.has(to));
  },
});

export const torpedosRule = defineResponseFilter({
  id: "torpedos",
  name: "Torpedos",
  description:
    "After a quiet pawn move, the same physical piece must move again if it has an ordinary legal move.",
  filter: (context, moves) => {
    const previous = lastMoveBy(context, context.color);
    if (
      previous === undefined ||
      previous.piece !== "pawn" ||
      isCapture(previous)
    ) {
      return moves;
    }
    return forceWhenAvailable(moves, ({ from }) => from === previous.to);
  },
});

export const stirCrazyRule = defineResponseFilter({
  id: "stir-crazy",
  name: "Stir Crazy",
  description:
    "After four consecutive affected-player turns without moving the king, the fifth primary mover must be the king.",
  filter: (context, moves) => {
    const ownHistory = movesBy(context, context.color);
    const previousFour = ownHistory.slice(-4);
    return previousFour.length === 4 &&
      previousFour.every(({ piece }) => piece !== "king")
      ? moves.filter(({ piece }) => piece === "king")
      : moves;
  },
});

function eraseRule(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const responseHistoryRules: readonly DrawbackRule<
  unknown,
  NoParameters
>[] = [
  boxingWithShadowRule,
  cowardlyRule,
  goingTheDistanceRule,
  leftToRightRule,
  relayRaceRule,
  religiousDisputeRule,
  simonSaysRule,
  superstitiousRule,
  torpedosRule,
  stirCrazyRule,
].map(eraseRule);
