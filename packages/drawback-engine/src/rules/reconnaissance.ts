import { Chess, type PieceSymbol } from "chess.js";
import type { DrawbackRule, PieceType } from "../types.js";
import type { NoParameters } from "./common.js";

const PIECE_TYPES: Readonly<Record<PieceSymbol, PieceType>> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

const CANONICAL_PIECE_TYPES: readonly PieceType[] = [
  "pawn",
  "knight",
  "bishop",
  "rook",
  "queen",
  "king",
];

export interface ReconnaissanceState {
  readonly movesApplied: number;
  readonly unlockedCapturedTypes: readonly PieceType[];
}

function canonicalTypes(types: ReadonlySet<PieceType>): readonly PieceType[] {
  return Object.freeze(
    CANONICAL_PIECE_TYPES.filter((type) => types.has(type)),
  );
}

function capturableTypes(fen: string): readonly PieceType[] {
  const types = new Set<PieceType>();
  for (const move of new Chess(fen).moves({ verbose: true })) {
    if (move.captured !== undefined) {
      types.add(PIECE_TYPES[move.captured]);
    }
  }
  return canonicalTypes(types);
}

export const reconnaissanceRule: DrawbackRule<
  ReconnaissanceState,
  NoParameters
> = {
  id: "reconnaissance",
  name: "Reconnaissance",
  description:
    "Captures are allowed only against piece types studied as ordinary legal capture targets on an earlier affected-player turn.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
    // Historical capture opportunities cannot be reconstructed from move-only
    // arbitrary-midgame history. Exact operation requires observation from the
    // game start, after which applyMove maintains the complete public state.
    unlockedCapturedTypes: Object.freeze([]),
  }),
  filterLegalMoves: (context, moves) => {
    const unlocked = new Set(context.state.unlockedCapturedTypes);
    return moves.filter(
      (move) =>
        move.captured === undefined || unlocked.has(move.captured),
    );
  },
  applyMove: (context) => {
    const unlocked = new Set(context.state.unlockedCapturedTypes);
    for (const type of capturableTypes(context.position.fen)) {
      unlocked.add(type);
    }
    return {
      movesApplied: context.state.movesApplied + 1,
      unlockedCapturedTypes: canonicalTypes(unlocked),
    };
  },
  checkStartOfTurnLoss: () => null,
};
