import type { DrawbackRule } from "../types.js";
import {
  isCapture,
  isDarkSquare,
  manhattanDistance,
} from "./common.js";
import type {
  HiddenSquareParameters,
  ParameterizedRuleState,
} from "./parameterized-factories.js";

export interface SquareColorParameters {
  readonly squareColor: "light" | "dark";
}

export interface CaptureParityParameters {
  readonly captureParity: "odd" | "even";
}

export const OBSERVED_CENTRAL_SQUARES = [
  "c4",
  "d4",
  "e4",
  "f4",
  "c5",
  "d5",
  "e5",
  "f5",
] as const;

function randomObservedCentralSquare(rng: {
  integer(exclusiveMaximum: number): number;
}): string {
  const square = OBSERVED_CENTRAL_SQUARES[
    rng.integer(OBSERVED_CENTRAL_SQUARES.length)
  ];
  if (square === undefined) {
    throw new RangeError("Random source returned an invalid square index.");
  }
  return square;
}

function nextState(
  context: Readonly<{ state: Readonly<ParameterizedRuleState> }>,
): ParameterizedRuleState {
  return { movesApplied: context.state.movesApplied + 1 };
}

function fenFullmove(fen: string): number {
  const value = Number(fen.split(/\s+/u)[5]);
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("FEN must contain a positive fullmove number.");
  }
  return value;
}

export const crenellationsRule: DrawbackRule<
  ParameterizedRuleState,
  SquareColorParameters
> = {
  id: "crenellations",
  name: "Crenellations",
  description: "Pawns may move only to squares of one hidden color.",
  verification: "implemented-unverified",
  generateParameters: (rng) => ({
    squareColor: rng.integer(2) === 0 ? "light" : "dark",
  }),
  initialize: () => ({ movesApplied: 0 }),
  filterLegalMoves: (context, moves) =>
    moves.filter(
      (move) =>
        move.piece !== "pawn" ||
        (isDarkSquare(move.to) ? "dark" : "light") ===
          context.parameters.squareColor,
    ),
  applyMove: nextState,
  checkStartOfTurnLoss: () => null,
};

export const theocracyRule: DrawbackRule<
  ParameterizedRuleState,
  CaptureParityParameters
> = {
  id: "theocracy",
  name: "Theocracy",
  description:
    "On hidden odd- or even-numbered moves, captures may only be made by bishops.",
  verification: "implemented-unverified",
  generateParameters: (rng) => ({
    captureParity: rng.integer(2) === 0 ? "odd" : "even",
  }),
  initialize: () => ({ movesApplied: 0 }),
  filterLegalMoves: (context, moves) => {
    const parity = fenFullmove(context.position.fen) % 2 === 0 ? "even" : "odd";
    if (parity !== context.parameters.captureParity) {
      return [...moves];
    }
    return moves.filter(
      (move) => !isCapture(move) || move.piece === "bishop",
    );
  },
  applyMove: nextState,
  checkStartOfTurnLoss: () => null,
};

export const activeVolcanoRule: DrawbackRule<
  ParameterizedRuleState,
  HiddenSquareParameters
> = {
  id: "active-volcano",
  name: "Active Volcano",
  description:
    "No piece may land on or orthogonally adjacent to one hidden square.",
  verification: "implemented-unverified",
  generateParameters: (rng) => ({ square: randomObservedCentralSquare(rng) }),
  initialize: () => ({ movesApplied: 0 }),
  filterLegalMoves: (context, moves) =>
    moves.filter(
      (move) =>
        move.to !== context.parameters.square &&
        manhattanDistance({
          ...move,
          from: context.parameters.square,
        }) !== 1,
    ),
  applyMove: nextState,
  checkStartOfTurnLoss: () => null,
};

export const comfortZoneRule: DrawbackRule<
  ParameterizedRuleState,
  HiddenSquareParameters
> = {
  id: "comfort-zone",
  name: "Comfort Zone",
  description:
    "If any ordinary legal move reaches one hidden square, the affected player must choose one.",
  verification: "implemented-unverified",
  generateParameters: (rng) => ({ square: randomObservedCentralSquare(rng) }),
  initialize: () => ({ movesApplied: 0 }),
  filterLegalMoves: (context, moves) => {
    const forced = moves.filter(
      (move) => move.to === context.parameters.square,
    );
    return forced.length === 0 ? [...moves] : forced;
  },
  applyMove: nextState,
  checkStartOfTurnLoss: () => null,
};

function eraseRule<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
): DrawbackRule<unknown, unknown> {
  return rule;
}

export const exactParameterizedRules: readonly DrawbackRule<
  unknown,
  unknown
>[] = [
  eraseRule(crenellationsRule),
  eraseRule(theocracyRule),
  eraseRule(activeVolcanoRule),
  eraseRule(comfortZoneRule),
];
