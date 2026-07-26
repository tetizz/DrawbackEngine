import { Chess, type Move, type PieceSymbol } from "chess.js";
import type {
  ChessMove,
  DrawbackRule,
  PromotionPiece,
} from "../types.js";
import {
  isCapture,
  squareCoordinates,
  type NoParameters,
} from "./common.js";

const PROMOTIONS: Readonly<Record<PromotionPiece, "n" | "b" | "r" | "q">> = {
  knight: "n",
  bishop: "b",
  rook: "r",
  queen: "q",
};

export interface DragState {
  readonly movesApplied: number;
  /** The original queen's current square, or null once captured. */
  readonly queenSquare: string | null;
}

function originalQueenSquare(
  color: ChessMove["color"],
  history: readonly ChessMove[],
): string | null {
  let square: string | null = color === "white" ? "d1" : "d8";
  for (const move of history) {
    if (square === null) {
      break;
    }
    if (move.color === color && move.from === square) {
      square = move.to;
    } else if (move.color !== color && isCapture(move) && move.to === square) {
      square = null;
    }
  }
  return square;
}

function pieceAt(fen: string, square: string): {
  readonly color: "w" | "b";
  readonly type: PieceSymbol;
} | undefined {
  if (!/^[a-h][1-8]$/.test(square)) {
    return undefined;
  }
  return new Chess(fen).get(square as Parameters<Chess["get"]>[0]);
}

/**
 * Drag uses the non-royal geometry interpretation: the original queen moves
 * at most one square, but may move onto attacked squares. Capturing that
 * tracked queen causes a loss at the start of its owner's next turn.
 */
export const dragRule: DrawbackRule<DragState, NoParameters> = {
  id: "drag",
  name: "Drag",
  description:
    "The original queen moves one square at a time; if it is captured, you lose.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
    queenSquare: originalQueenSquare(context.color, context.position.history),
  }),
  filterLegalMoves: (context, moves) =>
    moves.filter((move) => {
      if (move.from !== context.state.queenSquare) {
        return true;
      }
      const from = squareCoordinates(move.from);
      const to = squareCoordinates(move.to);
      return Math.max(
        Math.abs(to.file - from.file),
        Math.abs(to.rank - from.rank),
      ) <= 1;
    }),
  applyMove: (context, move) => ({
    movesApplied: context.state.movesApplied + 1,
    queenSquare:
      context.state.queenSquare !== null &&
      move.from === context.state.queenSquare
        ? move.to
        : context.state.queenSquare,
  }),
  checkStartOfTurnLoss: (context) => {
    if (context.state.queenSquare === null) {
      return {
        ruleId: "drag",
        color: context.color,
        reason: "The original queen was captured.",
      };
    }
    const piece = pieceAt(context.position.fen, context.state.queenSquare);
    const expectedColor = context.color === "white" ? "w" : "b";
    return piece?.type === "q" && piece.color === expectedColor
      ? null
      : {
          ruleId: "drag",
          color: context.color,
          reason: "The original queen was captured.",
        };
  },
};

function applyCandidate(fen: string, move: ChessMove): Chess {
  const chess = new Chess(fen);
  chess.move({
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined
      ? {}
      : { promotion: PROMOTIONS[move.promotion] }),
  });
  return chess;
}

function isReplyCaptureOn(reply: Move, square: string): boolean {
  return reply.to === square && reply.isCapture();
}

export function isSafeCapture(fen: string, move: ChessMove): boolean {
  if (!isCapture(move)) {
    return false;
  }
  const after = applyCandidate(fen, move);
  return !after
    .moves({ verbose: true })
    .some((reply) => isReplyCaptureOn(reply, move.to));
}

export const oohShinyRule: DrawbackRule<
  { readonly movesApplied: number },
  NoParameters
> = {
  id: "ooh-shiny",
  name: "Ooh Shiny",
  description:
    "If a legal capture cannot be legally recaptured on its destination, one such capture is compulsory.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
  }),
  filterLegalMoves: (context, moves) => {
    const safeCaptures = moves.filter(
      (move) => isSafeCapture(context.position.fen, move),
    );
    return safeCaptures.length === 0 ? [...moves] : safeCaptures;
  },
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
};

export const finalTacticalRules = Object.freeze([
  dragRule,
  oohShinyRule,
]);
