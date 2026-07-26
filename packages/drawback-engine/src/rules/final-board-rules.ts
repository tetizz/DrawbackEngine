import type { PlayerColor } from "@drawbackengine/shared";
import {
  parseFenPieces,
} from "../board-analysis.js";
import type {
  ChessMove,
  DrawbackRule,
} from "../types.js";
import {
  squareCoordinates,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

function initializeState(
  color: PlayerColor,
  history: readonly ChessMove[],
): StatelessRuleState {
  return {
    movesApplied: history.filter((move) => move.color === color).length,
  };
}

function nextState(state: Readonly<StatelessRuleState>): StatelessRuleState {
  return { movesApplied: state.movesApplied + 1 };
}

export function horizontallyReflectedSquare(square: string): string {
  const { file, rank } = squareCoordinates(square);
  return `${String.fromCharCode(96 + file)}${String(9 - rank)}`;
}

export const reflectiveRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "reflective",
  name: "Reflective",
  description:
    "A non-pawn primary mover may land only when the horizontally reflected destination square is occupied before the move.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) =>
    initializeState(context.color, context.position.history),
  filterLegalMoves: (context, moves) => {
    const occupied = new Set(
      parseFenPieces(context.position.fen).map((piece) => piece.square),
    );
    return moves.filter(
      (move) =>
        move.piece === "pawn" ||
        occupied.has(horizontallyReflectedSquare(move.to)),
    );
  },
  applyMove: (context) => nextState(context.state),
  checkStartOfTurnLoss: () => null,
};

function playerRelativeAdvance(color: PlayerColor, square: string): number {
  const rank = squareCoordinates(square).rank;
  return color === "white" ? rank : 9 - rank;
}

export function eyeOfSauronFrontier(
  color: PlayerColor,
  fen: string,
  ordinaryLegalMoves: readonly ChessMove[],
): number | null {
  const rookOrigins = parseFenPieces(fen)
    .filter((piece) => piece.color === color && piece.type === "rook")
    .map((piece) => piece.square);
  if (rookOrigins.length === 0) {
    return null;
  }
  const rookDestinations = ordinaryLegalMoves
    .filter((move) => move.color === color && move.piece === "rook")
    .map((move) => move.to);
  return Math.max(
    ...[...rookOrigins, ...rookDestinations].map(
      (square) => playerRelativeAdvance(color, square),
    ),
  );
}

export const eyeOfSauronRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "eye-of-sauron",
  name: "Eye of Sauron",
  description:
    "While a rook survives, non-pawn primary movers cannot advance beyond the farthest player-relative rank occupied or ordinarily reachable by an own rook.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) =>
    initializeState(context.color, context.position.history),
  filterLegalMoves: (context, moves) => {
    const frontier = eyeOfSauronFrontier(
      context.color,
      context.position.fen,
      moves,
    );
    if (frontier === null) {
      return [...moves];
    }
    return moves.filter(
      (move) =>
        move.piece === "pawn" ||
        playerRelativeAdvance(context.color, move.to) <= frontier,
    );
  },
  applyMove: (context) => nextState(context.state),
  checkStartOfTurnLoss: () => null,
};

function eraseRule<State>(
  rule: DrawbackRule<State, NoParameters>,
): DrawbackRule<unknown, unknown> {
  return rule;
}

export const finalBoardRules: readonly DrawbackRule<
  unknown,
  unknown
>[] = Object.freeze([
  eraseRule(reflectiveRule),
  eraseRule(eyeOfSauronRule),
]);
