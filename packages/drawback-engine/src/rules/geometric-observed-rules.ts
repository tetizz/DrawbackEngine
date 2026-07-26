import type { PlayerColor } from "@drawbackengine/shared";
import {
  areAdjacent,
  parseFenPieces,
  type BoardPiece,
} from "../board-analysis.js";
import type {
  ChessMove,
  DrawbackRule,
  RuleMoveContext,
} from "../types.js";
import {
  isCapture,
  squareCoordinates,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

interface GeometricFilterConfiguration {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly verification?: "implemented-unverified" | "partial";
  readonly filter: (
    context: RuleMoveContext<StatelessRuleState, NoParameters>,
    moves: readonly ChessMove[],
    pieces: readonly BoardPiece[],
  ) => readonly ChessMove[];
}

function defineGeometricFilter(
  configuration: GeometricFilterConfiguration,
): DrawbackRule<StatelessRuleState, NoParameters> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    verification: configuration.verification ?? "implemented-unverified",
    generateParameters: () => ({}),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (context, moves) => [
      ...configuration.filter(
        context,
        moves,
        parseFenPieces(context.position.fen),
      ),
    ],
    applyMove: (context) => ({
      movesApplied: context.state.movesApplied + 1,
    }),
    checkStartOfTurnLoss: () => null,
  };
}

function piecesFor(
  pieces: readonly BoardPiece[],
  color: PlayerColor,
): readonly BoardPiece[] {
  return pieces.filter((piece) => piece.color === color);
}

function opponentKing(
  pieces: readonly BoardPiece[],
  color: PlayerColor,
): BoardPiece {
  const king = pieces.find(
    (piece) => piece.color !== color && piece.type === "king",
  );
  if (king === undefined) {
    throw new RangeError("FEN does not contain the opponent king.");
  }
  return king;
}

function ownRoyal(
  pieces: readonly BoardPiece[],
  color: PlayerColor,
  type: "king" | "queen",
): BoardPiece | undefined {
  return pieces.find((piece) => piece.color === color && piece.type === type);
}

function ownQueens(
  pieces: readonly BoardPiece[],
  color: PlayerColor,
): readonly BoardPiece[] {
  return pieces.filter(
    (piece) => piece.color === color && piece.type === "queen",
  );
}

function isOpponentHalf(color: PlayerColor, square: string): boolean {
  const rank = squareCoordinates(square).rank;
  return color === "white" ? rank >= 5 : rank <= 4;
}

function squareDistance(left: string, right: string): number {
  const a = squareCoordinates(left);
  const b = squareCoordinates(right);
  return Math.abs(a.file - b.file) + Math.abs(a.rank - b.rank);
}

function isThunderdome(square: string): boolean {
  const { file, rank } = squareCoordinates(square);
  return file >= 3 && file <= 6 && rank >= 3 && rank <= 6;
}

function isRim(square: string): boolean {
  const { file, rank } = squareCoordinates(square);
  return file === 1 || file === 8 || rank === 1 || rank === 8;
}

export const crossingTheRubiconRule = defineGeometricFilter({
  id: "crossing-the-rubicon",
  name: "Crossing the Rubicon",
  description:
    "A piece whose primary origin is on the opponent's half cannot return to the affected player's half.",
  filter: (context, moves) =>
    moves.filter(
      (move) =>
        !isOpponentHalf(context.color, move.from) ||
        isOpponentHalf(context.color, move.to),
    ),
});

export const trueLoveRule = defineGeometricFilter({
  id: "true-love",
  name: "True Love",
  description:
    "King destinations must be adjacent to any own queen, and queen destinations must be adjacent to the own king.",
  filter: (context, moves, pieces) => {
    const king = ownRoyal(pieces, context.color, "king");
    if (king === undefined) {
      throw new RangeError(`FEN does not contain a ${context.color} king.`);
    }
    const queens = ownQueens(pieces, context.color);
    return moves.filter((move) => {
      if (move.piece === "king") {
        return queens.some((queen) => areAdjacent(move.to, queen.square));
      }
      if (move.piece === "queen") {
        return areAdjacent(move.to, king.square);
      }
      return true;
    });
  },
});

export const lethalAttractionRule = defineGeometricFilter({
  id: "lethal-attraction",
  name: "Lethal Attraction",
  description:
    "The primary mover cannot finish at a greater Manhattan distance from the opponent king than it started.",
  filter: (context, moves, pieces) => {
    const king = opponentKing(pieces, context.color);
    return moves.filter(
      (move) =>
        squareDistance(move.to, king.square) <=
        squareDistance(move.from, king.square),
    );
  },
});

export const thunderdomeRule = defineGeometricFilter({
  id: "thunderdome",
  name: "Thunderdome",
  description:
    "A piece cannot leave the middle sixteen squares while another piece remains there.",
  filter: (context, moves, pieces) => {
    const piecesInside = pieces
      .filter(({ square }) => isThunderdome(square)).length;
    return moves.filter(
      (move) =>
        !isThunderdome(move.from) ||
        isThunderdome(move.to) ||
        piecesInside === 1,
    );
  },
});

/**
 * Shared Irresistible predicate.
 *
 * Authority-specific rules must supply their complete legal move set. Literal
 * king captures remain exceptions even when a newly adjacent move exists.
 */
export function filterIrresistibleMoves(
  color: PlayerColor,
  moves: readonly ChessMove[],
  pieces: readonly BoardPiece[],
): readonly ChessMove[] {
  const king = opponentKing(pieces, color);
  const forced = moves.filter(
    (move) =>
      !areAdjacent(move.from, king.square) &&
      areAdjacent(move.to, king.square),
  );
  if (forced.length === 0) {
    return [...moves];
  }
  return moves.filter(
    (move) =>
      forced.includes(move) ||
      (isCapture(move) && move.captured === "king"),
  );
}

export const irresistibleRule = defineGeometricFilter({
  id: "irresistible",
  name: "Irresistible",
  description:
    "If possible, the affected player must move a previously non-adjacent piece adjacent to the opponent king.",
  verification: "partial",
  filter: (context, moves, pieces) =>
    filterIrresistibleMoves(context.color, moves, pieces),
});

export const primaDonnaRule = defineGeometricFilter({
  id: "prima-donna",
  name: "Prima Donna",
  description:
    "A move cannot leave more than one affected-player pawn on any file.",
  filter: (context, moves, pieces) => {
    const ownPawns = piecesFor(pieces, context.color)
      .filter(({ type }) => type === "pawn");
    return moves.filter((move) => {
      const counts = new Map<number, number>();
      for (const pawn of ownPawns) {
        const file = squareCoordinates(pawn.square).file;
        counts.set(file, (counts.get(file) ?? 0) + 1);
      }
      if (move.piece === "pawn") {
        const originFile = squareCoordinates(move.from).file;
        counts.set(originFile, (counts.get(originFile) ?? 0) - 1);
        if (move.promotion === undefined) {
          const destinationFile = squareCoordinates(move.to).file;
          counts.set(
            destinationFile,
            (counts.get(destinationFile) ?? 0) + 1,
          );
        }
      }
      return [...counts.values()].every((count) => count <= 1);
    });
  },
});

export const insideTheLinesRule = defineGeometricFilter({
  id: "inside-the-lines",
  name: "Inside the Lines",
  description:
    "A primary mover cannot enter the rim from a non-rim square; moves starting on the rim may stop there.",
  filter: (_context, moves) =>
    moves.filter(
      (move) => !isRim(move.to) || isRim(move.from),
    ),
});

function eraseRule(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const geometricObservedRules: readonly DrawbackRule<
  unknown,
  NoParameters
>[] = [
  crossingTheRubiconRule,
  trueLoveRule,
  lethalAttractionRule,
  thunderdomeRule,
  irresistibleRule,
  primaDonnaRule,
  insideTheLinesRule,
].map(eraseRule);
