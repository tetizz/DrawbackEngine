import type { PlayerColor } from "@drawbackengine/shared";
import type {
  ChessMove,
  DrawbackRule,
  RuleMoveContext,
} from "../types.js";
import {
  isCapture,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

interface HistoryFilterConfiguration {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly permits: (
    context: RuleMoveContext<StatelessRuleState, NoParameters>,
    move: ChessMove,
  ) => boolean;
}

function defineHistoryFilter(
  configuration: HistoryFilterConfiguration,
): DrawbackRule<StatelessRuleState, NoParameters> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    verification: "implemented-unverified",
    generateParameters: () => ({}),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (context, moves) =>
      moves.filter((move) => configuration.permits(context, move)),
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

function castleRookSquare(
  move: ChessMove,
  kind: "origin" | "destination",
): string | undefined {
  if (!move.flags.includes("castle")) {
    return undefined;
  }
  const squares: Readonly<Record<string, readonly [string, string]>> = {
    e1g1: ["h1", "f1"],
    e1c1: ["a1", "d1"],
    e8g8: ["h8", "f8"],
    e8c8: ["a8", "d8"],
  };
  const pair = squares[`${move.from}${move.to}`];
  if (pair === undefined) {
    throw new RangeError(
      `Cannot infer secondary rook movement for castling move ${move.from}-${move.to}.`,
    );
  }
  return pair[kind === "origin" ? 0 : 1];
}

function capturedSquare(move: ChessMove): string | undefined {
  if (!isCapture(move)) {
    return undefined;
  }
  if (move.flags.includes("en-passant")) {
    return `${move.to.slice(0, 1)}${move.from.slice(1, 2)}`;
  }
  return move.to;
}

function effectiveMoverValue(move: ChessMove): number {
  return VALUES[move.promotion ?? move.piece];
}

const VALUES: Readonly<Record<ChessMove["piece"], number>> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: Number.POSITIVE_INFINITY,
};

export const diplomaticImmunityRule = defineHistoryFilter({
  id: "diplomatic-immunity",
  name: "Diplomatic Immunity",
  description:
    "A piece that just made a non-capturing move cannot be captured immediately.",
  permits: (context, move) => {
    if (!isCapture(move)) {
      return true;
    }
    const lastOpponent = lastMoveBy(context, opposite(context.color));
    const lastMoverSquares = lastOpponent === undefined
      ? []
      : [
          lastOpponent.to,
          castleRookSquare(lastOpponent, "destination"),
        ].filter((square): square is string => square !== undefined);
    return lastOpponent === undefined ||
      isCapture(lastOpponent) ||
      !lastMoverSquares.includes(capturedSquare(move) ?? "");
  },
});

export const flattererRule = defineHistoryFilter({
  id: "flatterer",
  name: "Flatterer",
  description:
    "The affected player must match whether the opponent's previous mover was a pawn or non-pawn.",
  permits: (context, move) => {
    const lastOpponent = lastMoveBy(context, opposite(context.color));
    return lastOpponent === undefined ||
      (move.piece === "pawn") === (lastOpponent.piece === "pawn");
  },
});

export const hipsterRule = defineHistoryFilter({
  id: "hipster",
  name: "Hipster",
  description:
    "The affected player cannot move the same primary piece type as the opponent's previous mover.",
  permits: (context, move) => {
    const lastOpponent = lastMoveBy(context, opposite(context.color));
    return lastOpponent === undefined || move.piece !== lastOpponent.piece;
  },
});

export const hedonicTreadmillRule = defineHistoryFilter({
  id: "hedonic-treadmill",
  name: "Hedonic Treadmill",
  description:
    "The resulting piece must be at least as valuable as the opponent's previously moved resulting piece.",
  permits: (context, move) => {
    const lastOpponent = lastMoveBy(context, opposite(context.color));
    return lastOpponent === undefined ||
      effectiveMoverValue(move) >= effectiveMoverValue(lastOpponent);
  },
});

export const ladiesFirstRule = defineHistoryFilter({
  id: "ladies-first",
  name: "Ladies First",
  description:
    "The king may move only when the affected player's previous primary mover was the queen.",
  permits: (context, move) =>
    move.piece !== "king" ||
    lastMoveBy(context, context.color)?.piece === "queen",
});

export const centralizedCommandRule = defineHistoryFilter({
  id: "centralized-command",
  name: "Centralized Command",
  description:
    "A capture is permitted only if the affected player moved their king within their previous three turns.",
  permits: (context, move) =>
    !isCapture(move) ||
    movesBy(context, context.color)
      .slice(-3)
      .some(({ piece }) => piece === "king"),
});

export const royalJubileeRule = defineHistoryFilter({
  id: "royal-jubilee",
  name: "Royal Jubilee",
  description:
    "After capturing a non-pawn piece, the affected player's next mover must be a king or queen.",
  permits: (context, move) => {
    const previous = lastMoveBy(context, context.color);
    const obligation = previous !== undefined &&
      isCapture(previous) &&
      previous.captured !== "pawn";
    return !obligation || move.piece === "king" || move.piece === "queen";
  },
});

export const monkeySeeRule = defineHistoryFilter({
  id: "monkey-see",
  name: "Monkey See",
  description:
    "The affected player may capture only with piece types the opponent has previously captured with.",
  permits: (context, move) =>
    !isCapture(move) ||
    movesBy(context, opposite(context.color)).some(
      (historical) =>
        isCapture(historical) && historical.piece === move.piece,
    ),
});

export const hauntedRule = defineHistoryFilter({
  id: "haunted",
  name: "Haunted",
  description:
    "The affected player cannot move to a square where they previously made a capture.",
  permits: (context, move) =>
    !movesBy(context, context.color).some(
      (historical) => isCapture(historical) && historical.to === move.to,
    ),
});

export const scorchedEarthRule = defineHistoryFilter({
  id: "scorched-earth",
  name: "Scorched Earth",
  description:
    "The affected player cannot move to a square they previously moved from.",
  permits: (context, move) => {
    const burned = new Set<string>();
    for (const historical of movesBy(context, context.color)) {
      burned.add(historical.from);
      const rookOrigin = castleRookSquare(historical, "origin");
      if (rookOrigin !== undefined) {
        burned.add(rookOrigin);
      }
    }
    return !burned.has(move.to);
  },
});

export const turnTheOtherCheekRule = defineHistoryFilter({
  id: "turn-the-other-cheek",
  name: "Turn the Other Cheek",
  description: "The affected player cannot immediately recapture.",
  permits: (context, move) => {
    if (!isCapture(move)) {
      return true;
    }
    const lastOpponent = lastMoveBy(context, opposite(context.color));
    return lastOpponent === undefined ||
      !isCapture(lastOpponent) ||
      move.to !== lastOpponent.to;
  },
});

export const velociraptorRule = defineHistoryFilter({
  id: "velociraptor",
  name: "Velociraptor",
  description:
    "A captured piece type must have been a primary mover for the opponent within their previous three turns.",
  permits: (context, move) =>
    !isCapture(move) ||
    (move.captured !== undefined &&
      movesBy(context, opposite(context.color))
        .slice(-3)
        .some(({ piece }) => piece === move.captured)),
});

export const windupToysRule = defineHistoryFilter({
  id: "windup-toys",
  name: "Windup Toys",
  description:
    "From standard move thirteen onward, knights and bishops cannot move.",
  permits: (context, move) => {
    const fullmove = Number(context.position.fen.split(/\s+/u)[5]);
    if (!Number.isInteger(fullmove) || fullmove < 1) {
      throw new RangeError("FEN must contain a positive fullmove number.");
    }
    return fullmove <= 12 ||
      (move.piece !== "knight" && move.piece !== "bishop");
  },
});

export const doctorOctopusRule = defineHistoryFilter({
  id: "doctor-octopus",
  name: "Doctor Octopus",
  description:
    "The affected player may make at most eight captures of non-king pieces.",
  permits: (context, move) => {
    if (!isCapture(move) || move.captured === "king") {
      return true;
    }
    const captures = movesBy(context, context.color).filter(
      (historical) =>
        isCapture(historical) && historical.captured !== "king",
    ).length;
    return captures < 8;
  },
});

export const coweringInFearRule = defineHistoryFilter({
  id: "cowering-in-fear",
  name: "Cowering in Fear",
  description:
    "A mover cannot be less valuable than the most valuable piece the opponent has captured.",
  permits: (context, move) => {
    const capturedValues = movesBy(context, opposite(context.color))
      .flatMap((historical) =>
        historical.captured === undefined
          ? []
          : [VALUES[historical.captured]]);
    const threshold = capturedValues.length === 0
      ? 0
      : Math.max(...capturedValues);
    return VALUES[move.piece] >= threshold;
  },
});

function eraseRule(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const historyFilterRules: readonly DrawbackRule<
  unknown,
  NoParameters
>[] = [
  diplomaticImmunityRule,
  flattererRule,
  hipsterRule,
  hedonicTreadmillRule,
  ladiesFirstRule,
  centralizedCommandRule,
  royalJubileeRule,
  monkeySeeRule,
  hauntedRule,
  scorchedEarthRule,
  turnTheOtherCheekRule,
  velociraptorRule,
  windupToysRule,
  doctorOctopusRule,
  coweringInFearRule,
].map(eraseRule);
