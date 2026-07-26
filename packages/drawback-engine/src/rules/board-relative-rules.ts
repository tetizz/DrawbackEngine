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
  manhattanDistance,
  squareCoordinates,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

interface BoardFilterConfiguration {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly permits: (
    context: RuleMoveContext<StatelessRuleState, NoParameters>,
    move: ChessMove,
    pieces: readonly BoardPiece[],
  ) => boolean;
}

function defineBoardFilter(
  configuration: BoardFilterConfiguration,
): DrawbackRule<StatelessRuleState, NoParameters> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    verification: "implemented-unverified",
    generateParameters: () => ({}),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (context, moves) => {
      const pieces = parseFenPieces(context.position.fen);
      return moves.filter((move) => configuration.permits(context, move, pieces));
    },
    applyMove: (context) => ({
      movesApplied: context.state.movesApplied + 1,
    }),
    checkStartOfTurnLoss: () => null,
  };
}

function ownPieces(
  pieces: readonly BoardPiece[],
  color: PlayerColor,
): readonly BoardPiece[] {
  return pieces.filter((piece) => piece.color === color);
}

function opponentPieces(
  pieces: readonly BoardPiece[],
  color: PlayerColor,
): readonly BoardPiece[] {
  return pieces.filter((piece) => piece.color !== color);
}

function adjacentTo(
  square: string,
  pieces: readonly BoardPiece[],
  predicate: (piece: BoardPiece) => boolean = () => true,
): boolean {
  return pieces.some(
    (piece) => predicate(piece) && areAdjacent(square, piece.square),
  );
}

function isCastle(move: ChessMove): boolean {
  return move.flags.includes("castle");
}

function castleRookDestination(move: ChessMove): string | undefined {
  if (!isCastle(move)) {
    return undefined;
  }
  if (move.from === "e1" && move.to === "g1") {
    return "f1";
  }
  if (move.from === "e1" && move.to === "c1") {
    return "d1";
  }
  if (move.from === "e8" && move.to === "g8") {
    return "f8";
  }
  if (move.from === "e8" && move.to === "c8") {
    return "d8";
  }
  throw new RangeError(
    `Cannot infer secondary rook movement for castling move ${move.from}-${move.to}.`,
  );
}

function rank(square: string): number {
  return squareCoordinates(square).rank;
}

function isMoreAdvanced(
  color: PlayerColor,
  candidateRank: number,
  frontierRank: number,
): boolean {
  return color === "white"
    ? candidateRank > frontierRank
    : candidateRank < frontierRank;
}

export const cheerleadersRule = defineBoardFilter({
  id: "cheerleaders",
  name: "Cheerleaders",
  description:
    "A non-pawn piece may capture only while adjacent to one of the affected player's pawns.",
  permits: (context, move, pieces) =>
    move.piece === "pawn" ||
    !isCapture(move) ||
    adjacentTo(
      move.from,
      ownPieces(pieces, context.color),
      ({ type }) => type === "pawn",
    ),
});

export const nobleSteedRule = defineBoardFilter({
  id: "noble-steed",
  name: "Noble Steed",
  description:
    "A non-knight piece may move only while adjacent to one of the affected player's knights.",
  permits: (context, move, pieces) =>
    move.piece === "knight" ||
    adjacentTo(
      move.from,
      ownPieces(pieces, context.color),
      ({ type }) => type === "knight",
    ),
});

export const packMentalityRule = defineBoardFilter({
  id: "pack-mentality",
  name: "Pack Mentality",
  description:
    "A piece must finish adjacent to another one of the affected player's pieces.",
  permits: (context, move, pieces) =>
    isCastle(move) ||
    adjacentTo(
      move.to,
      ownPieces(pieces, context.color),
      ({ square }) => square !== move.from,
    ),
});

export const separationAnxietyRule = defineBoardFilter({
  id: "separation-anxiety",
  name: "Separation Anxiety",
  description:
    "A pawn that starts adjacent to its king may not leave the king's adjacent squares.",
  permits: (context, move, pieces) => {
    if (move.piece !== "pawn") {
      return true;
    }
    const king = ownPieces(pieces, context.color)
      .find(({ type }) => type === "king");
    if (king === undefined) {
      throw new RangeError(`FEN does not contain a ${context.color} king.`);
    }
    return !areAdjacent(move.from, king.square) ||
      areAdjacent(move.to, king.square);
  },
});

export const separationOfChurchAndStateRule = defineBoardFilter({
  id: "separation-of-church-and-state",
  name: "Separation of Church and State",
  description:
    "Bishops cannot move adjacent to a king, and kings cannot move adjacent to a bishop.",
  permits: (_context, move, pieces) => {
    if (move.piece === "bishop") {
      return !adjacentTo(
        move.to,
        pieces,
        ({ type }) => type === "king",
      );
    }
    if (move.piece === "king") {
      return !adjacentTo(
        move.to,
        pieces,
        (piece) =>
          piece.type === "bishop" &&
          !(isCapture(move) && piece.square === move.to),
      );
    }
    return true;
  },
});

export const siblingRivalryRule = defineBoardFilter({
  id: "sibling-rivalry",
  name: "Sibling Rivalry",
  description:
    "A piece cannot finish adjacent to an opposing piece of the same current type.",
  permits: (context, move, pieces) => {
    const opponents = opponentPieces(pieces, context.color);
    const resultingType = move.promotion ?? move.piece;
    const capturedSquare = move.flags.includes("en-passant")
      ? `${move.to.slice(0, 1)}${move.from.slice(1, 2)}`
      : isCapture(move)
        ? move.to
        : undefined;
    const primaryIsSeparated = !adjacentTo(
      move.to,
      opponents,
      (piece) =>
        piece.type === resultingType &&
        piece.square !== capturedSquare,
    );
    const rookDestination = castleRookDestination(move);
    return primaryIsSeparated &&
      (rookDestination === undefined ||
        !adjacentTo(
          rookDestination,
          opponents,
          ({ type }) => type === "rook",
        ));
  },
});

export const socialDistancingRule = defineBoardFilter({
  id: "social-distancing",
  name: "Social Distancing",
  description:
    "A non-capturing move cannot finish adjacent to an opposing piece.",
  permits: (context, move, pieces) =>
    isCapture(move) ||
    !adjacentTo(move.to, opponentPieces(pieces, context.color)),
});

export const spreadOutRule = defineBoardFilter({
  id: "spread-out",
  name: "Spread Out",
  description:
    "A non-pawn piece cannot finish adjacent to another own non-pawn piece, and castling is forbidden.",
  permits: (context, move, pieces) =>
    move.piece === "pawn" ||
    (!isCastle(move) &&
      !adjacentTo(
        move.to,
        ownPieces(pieces, context.color),
        (piece) => piece.type !== "pawn" && piece.square !== move.from,
      )),
});

export const torchlightRule = defineBoardFilter({
  id: "torchlight",
  name: "Torchlight",
  description:
    "A non-pawn move must start or finish adjacent to one of the affected player's pawns.",
  permits: (context, move, pieces) => {
    if (move.piece === "pawn") {
      return true;
    }
    const pawns = ownPieces(pieces, context.color)
      .filter(({ type }) => type === "pawn");
    return adjacentTo(move.from, pawns) || adjacentTo(move.to, pawns);
  },
});

export const royalBerthRule = defineBoardFilter({
  id: "royal-berth",
  name: "Royal Berth",
  description:
    "A move cannot place one of the affected player's pieces adjacent to their king.",
  permits: (context, move, pieces) => {
    if (move.piece === "king") {
      if (isCastle(move)) {
        return false;
      }
      return !adjacentTo(
        move.to,
        ownPieces(pieces, context.color),
        ({ square }) => square !== move.from,
      );
    }
    const king = ownPieces(pieces, context.color)
      .find(({ type }) => type === "king");
    if (king === undefined) {
      throw new RangeError(`FEN does not contain a ${context.color} king.`);
    }
    return !areAdjacent(move.to, king.square);
  },
});

export const peonsFirstRule = defineBoardFilter({
  id: "peons-first",
  name: "Peons First",
  description:
    "A piece cannot move while directly one square behind one of the affected player's pawns.",
  permits: (context, move, pieces) => {
    const origin = squareCoordinates(move.from);
    const pawnRank = origin.rank + (context.color === "white" ? 1 : -1);
    return !ownPieces(pieces, context.color).some(
      (piece) =>
        piece.type === "pawn" &&
        piece.square[0] === move.from[0] &&
        rank(piece.square) === pawnRank,
    );
  },
});

export const powerCellsRule = defineBoardFilter({
  id: "power-cells",
  name: "Power Cells",
  description:
    "A move's Manhattan distance cannot exceed the affected player's current pawn count.",
  permits: (context, move, pieces) => {
    const pawnCount = ownPieces(pieces, context.color)
      .filter(({ type }) => type === "pawn").length;
    return manhattanDistance(move) <= pawnCount;
  },
});

export const leadingTheChargeRule = defineBoardFilter({
  id: "leading-the-charge",
  name: "Leading the Charge",
  description:
    "While a knight remains, non-knights cannot move ahead of the most advanced own knight.",
  permits: (context, move, pieces) => {
    if (move.piece === "knight") {
      return true;
    }
    const knightRanks = ownPieces(pieces, context.color)
      .filter(({ type }) => type === "knight")
      .map(({ square }) => rank(square));
    if (knightRanks.length === 0) {
      return true;
    }
    const frontier = context.color === "white"
      ? Math.max(...knightRanks)
      : Math.min(...knightRanks);
    return !isMoreAdvanced(context.color, rank(move.to), frontier);
  },
});

export const scoutingAheadRule = defineBoardFilter({
  id: "scouting-ahead",
  name: "Scouting Ahead",
  description:
    "While a pawn remains, non-pawns cannot move ahead of the most advanced own pawn.",
  permits: (context, move, pieces) => {
    if (move.piece === "pawn") {
      return true;
    }
    const pawnRanks = ownPieces(pieces, context.color)
      .filter(({ type }) => type === "pawn")
      .map(({ square }) => rank(square));
    if (pawnRanks.length === 0) {
      return true;
    }
    const frontier = context.color === "white"
      ? Math.max(...pawnRanks)
      : Math.min(...pawnRanks);
    return !isMoreAdvanced(context.color, rank(move.to), frontier);
  },
});

function eraseRule(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const boardRelativeRules: readonly DrawbackRule<
  unknown,
  NoParameters
>[] = [
  cheerleadersRule,
  nobleSteedRule,
  packMentalityRule,
  separationAnxietyRule,
  separationOfChurchAndStateRule,
  siblingRivalryRule,
  socialDistancingRule,
  spreadOutRule,
  torchlightRule,
  royalBerthRule,
  peonsFirstRule,
  powerCellsRule,
  leadingTheChargeRule,
  scoutingAheadRule,
].map(eraseRule);
