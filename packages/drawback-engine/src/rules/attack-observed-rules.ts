import type { PlayerColor } from "@drawbackengine/shared";
import {
  isSquareAttacked,
  isSquareAttackedByQueen,
  parseFenPieces,
  type BoardPiece,
} from "../board-analysis.js";
import type {
  ChessMove,
  DrawbackLoss,
  DrawbackRule,
  RuleLossContext,
  RuleMoveContext,
} from "../types.js";
import {
  isCapture,
  squareCoordinates,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function originAttacked(
  context: RuleMoveContext<unknown, NoParameters>,
  move: ChessMove,
): boolean {
  return isSquareAttacked(
    context.position.fen,
    move.from,
    opposite(context.color),
  );
}

function defineAttackFilter(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly filter: (
    context: RuleMoveContext<StatelessRuleState, NoParameters>,
    moves: readonly ChessMove[],
  ) => readonly ChessMove[];
}): DrawbackRule<StatelessRuleState, NoParameters> {
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

export const deerInTheHeadlightsRule = defineAttackFilter({
  id: "deer-in-the-headlights",
  name: "Deer in the Headlights",
  description:
    "A primary mover cannot move while its origin square is attacked by an opponent piece.",
  filter: (context, moves) =>
    moves.filter((move) => !originAttacked(context, move)),
});

export const jumpyRule = defineAttackFilter({
  id: "jumpy",
  name: "Jumpy",
  description:
    "If any attacked piece has an ordinary legal move, the affected player must move an attacked piece.",
  filter: (context, moves) => {
    const attacked = moves.filter((move) => originAttacked(context, move));
    return attacked.length === 0 ? moves : attacked;
  },
});

export const medusaRule = defineAttackFilter({
  id: "medusa",
  name: "Medusa",
  description:
    "A primary mover attacked along an unobstructed line by an opponent queen cannot move.",
  filter: (context, moves) =>
    moves.filter(
      (move) =>
        !isSquareAttackedByQueen(
          context.position.fen,
          move.from,
          opposite(context.color),
        ),
    ),
});

export const standYourGroundRule = defineAttackFilter({
  id: "stand-your-ground",
  name: "Stand Your Ground",
  description:
    "A primary mover may capture only when its origin square is attacked by an opponent piece.",
  filter: (context, moves) =>
    moves.filter(
      (move) => !isCapture(move) || originAttacked(context, move),
    ),
});

function distance(left: string, right: string): number {
  const a = squareCoordinates(left);
  const b = squareCoordinates(right);
  return Math.abs(a.file - b.file) + Math.abs(a.rank - b.rank);
}

export const unrequitedLoveRule = defineAttackFilter({
  id: "unrequited-love",
  name: "Unrequited Love",
  description:
    "The king cannot increase its distance to the nearest own queen, and an own queen cannot move closer to the own king.",
  filter: (context, moves) => {
    const pieces = parseFenPieces(context.position.fen);
    const king = pieces.find(
      (piece) => piece.color === context.color && piece.type === "king",
    );
    if (king === undefined) {
      throw new RangeError(`FEN does not contain a ${context.color} king.`);
    }
    const queens = pieces.filter(
      (piece) => piece.color === context.color && piece.type === "queen",
    );
    return moves.filter((move) => {
      if (move.piece === "king") {
        return queens.length > 0 && Math.min(
          ...queens.map((queen) => distance(move.to, queen.square)),
        ) <= Math.min(
          ...queens.map((queen) => distance(move.from, queen.square)),
        );
      }
      if (move.piece === "queen") {
        return distance(move.to, king.square) >=
          distance(move.from, king.square);
      }
      return true;
    });
  },
});

function defineBoardLoss(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly reason: string;
  readonly loses: (
    context: RuleLossContext<StatelessRuleState, NoParameters>,
    pieces: readonly BoardPiece[],
  ) => boolean;
}): DrawbackRule<StatelessRuleState, NoParameters> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    verification: "implemented-unverified",
    generateParameters: () => ({}),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (_context, moves) => [...moves],
    applyMove: (context) => ({
      movesApplied: context.state.movesApplied + 1,
    }),
    checkStartOfTurnLoss: (context): DrawbackLoss | null =>
      configuration.loses(context, parseFenPieces(context.position.fen))
        ? {
            ruleId: configuration.id,
            color: context.color,
            reason: configuration.reason,
          }
        : null,
  };
}

export const helicopterParentRule = defineBoardLoss({
  id: "helicopter-parent",
  name: "Helicopter Parent",
  description:
    "The affected player loses if any own pawn is not defended by another own piece.",
  reason: "At least one own pawn is undefended.",
  loses: (context, pieces) =>
    pieces.some(
      (piece) =>
        piece.color === context.color &&
        piece.type === "pawn" &&
        !isSquareAttacked(
          context.position.fen,
          piece.square,
          context.color,
        ),
    ),
});

export const paranoidRule = defineBoardLoss({
  id: "paranoid",
  name: "Paranoid",
  description:
    "The affected player loses if their king is not defended by another own piece.",
  reason: "The affected player's king is undefended.",
  loses: (context, pieces) => {
    const king = pieces.find(
      (piece) => piece.color === context.color && piece.type === "king",
    );
    if (king === undefined) {
      throw new RangeError(`FEN does not contain a ${context.color} king.`);
    }
    return !isSquareAttacked(
      context.position.fen,
      king.square,
      context.color,
    );
  },
});

export interface RookBuddiesState {
  readonly movesApplied: number;
  readonly connectedEver: boolean;
}

function rooksConnected(fen: string, color: PlayerColor): boolean {
  const pieces = parseFenPieces(fen);
  const occupied = new Set(pieces.map(({ square }) => square));
  const rooks = pieces.filter(
    (piece) => piece.color === color && piece.type === "rook",
  );
  return rooks.some((rook, index) =>
    rooks.slice(index + 1).some((candidate) => {
      const a = squareCoordinates(rook.square);
      const b = squareCoordinates(candidate.square);
      if (a.file !== b.file && a.rank !== b.rank) {
        return false;
      }
      const fileStep = Math.sign(b.file - a.file);
      const rankStep = Math.sign(b.rank - a.rank);
      let file = a.file + fileStep;
      let rank = a.rank + rankStep;
      while (file !== b.file || rank !== b.rank) {
        const square = `${String.fromCharCode(96 + file)}${String(rank)}`;
        if (occupied.has(square)) {
          return false;
        }
        file += fileStep;
        rank += rankStep;
      }
      return true;
    }),
  );
}

export const rookBuddiesRule: DrawbackRule<
  RookBuddiesState,
  NoParameters
> = {
  id: "rook-buddies",
  name: "Rook Buddies",
  description:
    "Rooks and castling are locked until two own rooks have shared an unobstructed rank or file.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
    connectedEver: rooksConnected(context.position.fen, context.color),
  }),
  filterLegalMoves: (context, moves) =>
    context.state.connectedEver ||
    rooksConnected(context.position.fen, context.color)
      ? [...moves]
      : moves.filter(
          (move) =>
            move.piece !== "rook" && !move.flags.includes("castle"),
        ),
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
    connectedEver:
      context.state.connectedEver ||
      rooksConnected(context.position.fen, context.color) ||
      rooksConnected(context.positionAfterMove.fen, context.color),
  }),
  checkStartOfTurnLoss: () => null,
};

function eraseRule<State>(
  rule: DrawbackRule<State, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const attackObservedRules: readonly DrawbackRule<
  unknown,
  NoParameters
>[] = [
  deerInTheHeadlightsRule,
  jumpyRule,
  medusaRule,
  standYourGroundRule,
  unrequitedLoveRule,
  helicopterParentRule,
  paranoidRule,
  rookBuddiesRule,
].map(eraseRule);
