import type { PlayerColor, RandomSource } from "@drawbackengine/shared";
import type {
  ChessMove,
  DrawbackRule,
  PieceType,
} from "../types.js";
import {
  isDarkSquare,
  squareCoordinates,
} from "./common.js";

export interface RerandomizedSeedParameters {
  readonly seed: number;
}

export interface RerandomizedRuleState<Constraint> {
  readonly movesApplied: number;
  readonly currentConstraint: Constraint;
}

export type SquareColor = "dark" | "light";
export type HorizontalDirection = "left" | "right";

const COLORBLIND_DOMAIN = 0x434f_4c52;
const HAND_DOMAIN = 0x4841_4e44;
const OBSESSION_DOMAIN = 0x4f42_5345;
const WINDS_DOMAIN = 0x5749_4e44;

const PIECE_TYPES: readonly PieceType[] = Object.freeze([
  "pawn",
  "knight",
  "bishop",
  "rook",
  "queen",
  "king",
]);

const SQUARES: readonly string[] = Object.freeze(
  Array.from({ length: 64 }, (_, index) => {
    const file = String.fromCharCode("a".charCodeAt(0) + index % 8);
    const rank = Math.floor(index / 8) + 1;
    return `${file}${String(rank)}`;
  }),
);

function turnWord(seed: number, movesApplied: number, domain: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("Rerandomized seed must be a uint32 value.");
  }
  if (!Number.isSafeInteger(movesApplied) || movesApplied < 0) {
    throw new RangeError("movesApplied must be a non-negative safe integer.");
  }
  let value = (
    (seed >>> 0) ^
    (domain >>> 0) ^
    Math.imul((movesApplied + 1) >>> 0, 0x9e37_79b9)
  ) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0_aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a_2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

function selected<Choice>(
  choices: readonly Choice[],
  seed: number,
  movesApplied: number,
  domain: number,
): Choice {
  const choice = choices[turnWord(seed, movesApplied, domain) % choices.length];
  if (choice === undefined) {
    throw new Error("Rerandomized selection invariant failed.");
  }
  return choice;
}

export function forbiddenColorForTurn(
  parameters: RerandomizedSeedParameters,
  movesApplied: number,
): SquareColor {
  return selected(
    ["dark", "light"] as const,
    parameters.seed,
    movesApplied,
    COLORBLIND_DOMAIN,
  );
}

export function requiredMoverTypeForTurn(
  parameters: RerandomizedSeedParameters,
  movesApplied: number,
): PieceType {
  return selected(
    PIECE_TYPES,
    parameters.seed,
    movesApplied,
    HAND_DOMAIN,
  );
}

export function obsessionSquareForTurn(
  parameters: RerandomizedSeedParameters,
  movesApplied: number,
): string {
  return selected(
    SQUARES,
    parameters.seed,
    movesApplied,
    OBSESSION_DOMAIN,
  );
}

export function forbiddenDirectionForTurn(
  parameters: RerandomizedSeedParameters,
  movesApplied: number,
): HorizontalDirection {
  return selected(
    ["left", "right"] as const,
    parameters.seed,
    movesApplied,
    WINDS_DOMAIN,
  );
}

export function filterColorblindMoves(
  forbidden: SquareColor,
  moves: readonly ChessMove[],
): readonly ChessMove[] {
  return moves.filter((move) =>
    isDarkSquare(move.to)
      ? forbidden !== "dark"
      : forbidden !== "light"
  );
}

export function filterHandAndBrainlessMoves(
  required: PieceType,
  moves: readonly ChessMove[],
): readonly ChessMove[] {
  return moves.filter((move) => move.piece === required);
}

export function filterObsessionMoves(
  target: string,
  moves: readonly ChessMove[],
): readonly ChessMove[] {
  const matching = moves.filter((move) => move.to === target);
  return matching.length === 0 ? [...moves] : matching;
}

function moveDirection(
  color: PlayerColor,
  move: Pick<ChessMove, "from" | "to">,
): HorizontalDirection | null {
  const delta = squareCoordinates(move.to).file -
    squareCoordinates(move.from).file;
  if (delta === 0) {
    return null;
  }
  const movesTowardWhiteLeft = delta < 0;
  return color === "white"
    ? movesTowardWhiteLeft ? "left" : "right"
    : movesTowardWhiteLeft ? "right" : "left";
}

export function filterWindsOfFateMoves(
  color: PlayerColor,
  forbidden: HorizontalDirection,
  moves: readonly ChessMove[],
): readonly ChessMove[] {
  return moves.filter(
    (move) => moveDirection(color, move) !== forbidden,
  );
}

function generatedSeed(rng: RandomSource): RerandomizedSeedParameters {
  return { seed: rng.integer(0x1_0000_0000) };
}

function ownMoveCount(
  color: PlayerColor,
  history: readonly ChessMove[],
): number {
  return history.filter((move) => move.color === color).length;
}

function defineRerandomizedRule<Constraint>(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly constraint: (
    parameters: RerandomizedSeedParameters,
    movesApplied: number,
  ) => Constraint;
  readonly filter: (
    color: PlayerColor,
    constraint: Constraint,
    moves: readonly ChessMove[],
  ) => readonly ChessMove[];
  readonly describe: (constraint: Constraint) => string;
}): DrawbackRule<
  RerandomizedRuleState<Constraint>,
  RerandomizedSeedParameters
> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    verification: "implemented-unverified",
    generateParameters: generatedSeed,
    initialize: (context) => {
      const movesApplied = ownMoveCount(
        context.color,
        context.position.history,
      );
      return {
        movesApplied,
        currentConstraint: configuration.constraint(
          context.parameters,
          movesApplied,
        ),
      };
    },
    filterLegalMoves: (context, moves) =>
      configuration.filter(
        context.color,
        context.state.currentConstraint,
        moves,
      ),
    applyMove: (context) => {
      const movesApplied = context.state.movesApplied + 1;
      return {
        movesApplied,
        currentConstraint: configuration.constraint(
          context.parameters,
          movesApplied,
        ),
      };
    },
    checkStartOfTurnLoss: () => null,
    describeTurn: (context) => [
      configuration.describe(context.state.currentConstraint),
    ],
  };
}

export const colorblindRule = defineRerandomizedRule({
  id: "colorblind",
  name: "Colorblind",
  description:
    "One destination-square color is forbidden and independently rerandomized each affected-player turn.",
  constraint: forbiddenColorForTurn,
  filter: (_color, forbidden, moves) =>
    filterColorblindMoves(forbidden, moves),
  describe: (forbidden) => `Forbidden destination: ${forbidden} squares`,
});

export const handAndBrainlessRule = defineRerandomizedRule({
  id: "hand-and-brainless",
  name: "Hand and Brainless",
  description:
    "One required primary mover type is independently rerandomized each affected-player turn.",
  constraint: requiredMoverTypeForTurn,
  filter: (_color, required, moves) =>
    filterHandAndBrainlessMoves(required, moves),
  describe: (required) => `Required mover: ${required}`,
});

export const obsessionRule = defineRerandomizedRule({
  id: "obsession",
  name: "Obsession",
  description:
    "One target square is rerandomized each affected-player turn; if any ordinary move reaches it, one of those moves is required.",
  constraint: obsessionSquareForTurn,
  filter: (_color, target, moves) => filterObsessionMoves(target, moves),
  describe: (target) => `Target square: ${target}`,
});

export const windsOfFateRule = defineRerandomizedRule({
  id: "winds-of-fate",
  name: "Winds of Fate",
  description:
    "Either player-relative leftward or rightward primary movement is forbidden and independently rerandomized each affected-player turn.",
  constraint: forbiddenDirectionForTurn,
  filter: (color, forbidden, moves) =>
    filterWindsOfFateMoves(color, forbidden, moves),
  describe: (forbidden) => `Forbidden direction: ${forbidden}`,
});

function eraseRule<State>(
  rule: DrawbackRule<State, RerandomizedSeedParameters>,
): DrawbackRule<unknown, unknown> {
  return rule;
}

export const rerandomizedRules: readonly DrawbackRule<
  unknown,
  unknown
>[] = Object.freeze([
  eraseRule(colorblindRule),
  eraseRule(handAndBrainlessRule),
  eraseRule(obsessionRule),
  eraseRule(windsOfFateRule),
]);
