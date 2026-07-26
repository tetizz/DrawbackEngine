import type {
  DrawbackRule,
  RuleInitializationContext,
  RuleTransitionContext,
} from "../types.js";
import type { PlayerColor } from "@drawbackengine/shared";
import { isCapture, type NoParameters } from "./common.js";

export interface TrackedPiece {
  readonly id: string;
  readonly square: string;
}

export interface BattleFatigueState {
  readonly pieces: readonly TrackedPiece[];
  readonly fatiguedIds: readonly string[];
  readonly nextIdentity: number;
}

function occupiedSquares(fen: string, color: PlayerColor): readonly string[] {
  const board = fen.split(" ")[0];
  if (board === undefined) {
    return [];
  }
  const ranks = board.split("/");
  if (ranks.length !== 8) {
    return [];
  }
  const squares: string[] = [];
  ranks.forEach((rank, rankIndex) => {
    let fileIndex = 0;
    for (const token of rank) {
      const empty = Number(token);
      if (Number.isInteger(empty) && empty >= 1 && empty <= 8) {
        fileIndex += empty;
      } else {
        const isWhite = token === token.toUpperCase();
        if ((color === "white") === isWhite) {
          squares.push(
            `${String.fromCharCode("a".charCodeAt(0) + fileIndex)}${String(8 - rankIndex)}`,
          );
        }
        fileIndex += 1;
      }
    }
  });
  return squares;
}

function initialState(
  context: RuleInitializationContext<NoParameters>,
): BattleFatigueState {
  const pieces = occupiedSquares(context.position.fen, context.color).map(
    (square, index) => ({
      id: `${context.color}-${String(index)}`,
      square,
    }),
  );
  return { pieces, fatiguedIds: [], nextIdentity: pieces.length };
}

function reconciledPieces(
  context: RuleTransitionContext<BattleFatigueState, NoParameters>,
): { readonly pieces: readonly TrackedPiece[]; readonly nextIdentity: number } {
  const occupied = new Set(occupiedSquares(context.position.fen, context.color));
  const retained = context.state.pieces.filter((piece) => occupied.has(piece.square));
  const knownSquares = new Set(retained.map((piece) => piece.square));
  let nextIdentity = context.state.nextIdentity;
  const discovered = [...occupied]
    .filter((square) => !knownSquares.has(square))
    .sort()
    .map((square) => {
      const piece = { id: `${context.color}-${String(nextIdentity)}`, square };
      nextIdentity += 1;
      return piece;
    });
  return { pieces: [...retained, ...discovered], nextIdentity };
}

function castleRookSquares(
  color: PlayerColor,
  flags: string,
): readonly [string, string] | null {
  const rank = color === "white" ? "1" : "8";
  if (flags.split(",").includes("kingside-castle")) {
    return [`h${rank}`, `f${rank}`];
  }
  if (flags.split(",").includes("queenside-castle")) {
    return [`a${rank}`, `d${rank}`];
  }
  return null;
}

export const battleFatigueRule: DrawbackRule<BattleFatigueState, NoParameters> = {
  id: "battle-fatigue",
  name: "Battle Fatigue",
  description: "A piece that captures cannot capture again until it moves without capturing.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: initialState,
  filterLegalMoves: (context, moves) => {
    const fatigued = new Set(context.state.fatiguedIds);
    const identities = new Map(
      context.state.pieces.map((piece) => [piece.square, piece.id]),
    );
    return moves.filter((move) => {
      const identity = identities.get(move.from);
      return identity === undefined || !fatigued.has(identity) || !isCapture(move);
    });
  },
  applyMove: (context, move) => {
    const reconciled = reconciledPieces(context);
    const moving = reconciled.pieces.find((piece) => piece.square === move.from);
    if (moving === undefined) {
      throw new Error(`Battle Fatigue could not identify the mover on ${move.from}.`);
    }
    const castleRook = castleRookSquares(context.color, move.flags);
    const pieces = reconciled.pieces.map((piece) => {
      if (piece.id === moving.id) {
        return { ...piece, square: move.to };
      }
      if (castleRook !== null && piece.square === castleRook[0]) {
        return { ...piece, square: castleRook[1] };
      }
      return piece;
    });
    const fatigued = new Set(context.state.fatiguedIds);
    if (isCapture(move)) {
      fatigued.add(moving.id);
    } else {
      fatigued.delete(moving.id);
    }
    const liveIds = new Set(pieces.map((piece) => piece.id));
    return {
      pieces,
      fatiguedIds: [...fatigued].filter((identity) => liveIds.has(identity)),
      nextIdentity: reconciled.nextIdentity,
    };
  },
  checkStartOfTurnLoss: () => null,
};
