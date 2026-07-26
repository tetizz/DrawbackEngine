import type { PlayerColor } from "@drawbackengine/shared";
import {
  areAdjacent,
  isDestinationDefendedAfterMove,
  parseFenPieces,
} from "../board-analysis.js";
import type {
  ChessMove,
  DrawbackLoss,
  DrawbackRule,
  PieceType,
} from "../types.js";
import {
  isCapture,
  squareCoordinates,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

export const friendlyFireRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "friendly-fire",
  name: "Friendly Fire",
  description:
    "Every primary mover must finish on a square defended by another own piece in the resulting position.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: () => ({ movesApplied: 0 }),
  filterLegalMoves: (context, moves) =>
    moves.filter(
      (move) => isDestinationDefendedAfterMove(context.position.fen, move),
    ),
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
};

export const protectedPawnsRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "protected-pawns",
  name: "Protected Pawns",
  description:
    "A primary pawn mover must finish on a square defended by another own piece in the resulting position.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: () => ({ movesApplied: 0 }),
  filterLegalMoves: (context, moves) =>
    moves.filter(
      (move) =>
        move.piece !== "pawn" ||
        isDestinationDefendedAfterMove(context.position.fen, move),
    ),
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
};

export interface RookOnTheSeventhState {
  readonly movesApplied: number;
  readonly achieved: boolean;
}

function targetRookRank(color: PlayerColor): number {
  return color === "white" ? 7 : 2;
}

function reachesTargetRank(move: ChessMove, color: PlayerColor): boolean {
  return move.piece === "rook" &&
    squareCoordinates(move.to).rank === targetRookRank(color);
}

export const rookOnTheSeventhRule: DrawbackRule<
  RookOnTheSeventhState,
  NoParameters
> = {
  id: "rook-on-the-seventh",
  name: "Rook on the Seventh",
  description:
    "By the affected player's fifteenth turn, a primary rook must have moved to the opponent's second rank.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => {
    const own = context.position.history.filter(
      (move) => move.color === context.color,
    );
    return {
      movesApplied: own.length,
      achieved: own.some(
        (move) => reachesTargetRank(move, context.color),
      ),
    };
  },
  filterLegalMoves: (context, moves) =>
    !context.state.achieved && context.state.movesApplied === 14
      ? moves.filter(
          (move) => reachesTargetRank(move, context.color),
        )
      : [...moves],
  applyMove: (context, move) => ({
    movesApplied: context.state.movesApplied + 1,
    achieved:
      context.state.achieved || reachesTargetRank(move, context.color),
  }),
  checkStartOfTurnLoss: (context): DrawbackLoss | null =>
    !context.state.achieved && context.state.movesApplied >= 15
      ? {
          ruleId: "rook-on-the-seventh",
          color: context.color,
          reason:
            "No primary rook reached the opponent's second rank by turn fifteen.",
        }
      : null,
};

function underwater(
  color: PlayerColor,
  square: string,
  level: number,
): boolean {
  const rank = squareCoordinates(square).rank;
  return color === "white" ? rank <= level : rank >= 9 - level;
}

export const risingWaterRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "rising-water",
  name: "Rising Water",
  description:
    "Every ten affected-player turns, one rank from the affected player's home edge becomes impassable and immobilizes pieces on it.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
  }),
  filterLegalMoves: (context, moves) => {
    const level = Math.min(8, Math.floor(context.state.movesApplied / 10));
    return moves.filter(
      (move) =>
        !underwater(context.color, move.from, level) &&
        !underwater(context.color, move.to, level),
    );
  },
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
};

export type QueenDisguiseMode = "rook" | "bishop";

export interface QueenDisguiseState {
  readonly movesApplied: number;
  readonly trackedSquare: string | null;
  readonly mode: QueenDisguiseMode | null;
}

function queenMode(move: Pick<ChessMove, "from" | "to">): QueenDisguiseMode {
  const from = squareCoordinates(move.from);
  const to = squareCoordinates(move.to);
  const fileDelta = Math.abs(to.file - from.file);
  const rankDelta = Math.abs(to.rank - from.rank);
  if ((fileDelta === 0) !== (rankDelta === 0)) {
    return "rook";
  }
  if (fileDelta > 0 && fileDelta === rankDelta) {
    return "bishop";
  }
  throw new RangeError(
    `Queen move ${move.from}-${move.to} is neither orthogonal nor diagonal.`,
  );
}

function liveTrackedQueen(
  fen: string,
  color: PlayerColor,
  square: string | null,
): string | null {
  if (square === null) {
    return null;
  }
  return parseFenPieces(fen).some(
    (piece) =>
      piece.color === color &&
      piece.type === "queen" &&
      piece.square === square,
  )
    ? square
    : null;
}

function reconstructQueenDisguise(
  color: PlayerColor,
  history: readonly ChessMove[],
): Pick<QueenDisguiseState, "trackedSquare" | "mode"> {
  let trackedSquare: string | null = color === "white" ? "d1" : "d8";
  let mode: QueenDisguiseMode | null = null;
  for (const move of history) {
    if (
      trackedSquare !== null &&
      move.color === color &&
      move.piece === "queen" &&
      move.from === trackedSquare
    ) {
      mode ??= queenMode(move);
      trackedSquare = move.to;
    } else if (
      trackedSquare !== null &&
      move.color !== color &&
      isCapture(move) &&
      move.to === trackedSquare
    ) {
      trackedSquare = null;
    }
  }
  return { trackedSquare, mode };
}

export const queenDisguiseRule: DrawbackRule<
  QueenDisguiseState,
  NoParameters
> = {
  id: "queen-disguise",
  name: "Queen Disguise",
  description:
    "The original queen may initially move as a rook or bishop, then remains restricted to the first movement family it uses.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => {
    const reconstructed = reconstructQueenDisguise(
      context.color,
      context.position.history,
    );
    return {
      movesApplied: context.position.history.filter(
        (move) => move.color === context.color,
      ).length,
      trackedSquare: liveTrackedQueen(
        context.position.fen,
        context.color,
        reconstructed.trackedSquare,
      ),
      mode: reconstructed.mode,
    };
  },
  filterLegalMoves: (context, moves) => {
    const tracked = liveTrackedQueen(
      context.position.fen,
      context.color,
      context.state.trackedSquare,
    );
    return moves.filter(
      (move) =>
        tracked === null ||
        move.from !== tracked ||
        context.state.mode === null ||
        queenMode(move) === context.state.mode,
    );
  },
  applyMove: (context, move) => {
    const tracked = liveTrackedQueen(
      context.position.fen,
      context.color,
      context.state.trackedSquare,
    );
    const movedTracked = tracked !== null && move.from === tracked;
    return {
      movesApplied: context.state.movesApplied + 1,
      trackedSquare: movedTracked ? move.to : tracked,
      mode: movedTracked
        ? context.state.mode ?? queenMode(move)
        : context.state.mode,
    };
  },
  checkStartOfTurnLoss: () => null,
};

const KISS_TYPES = ["bishop", "knight", "rook"] as const satisfies
  readonly PieceType[];
type KissType = (typeof KISS_TYPES)[number];

export interface NowKissState {
  readonly movesApplied: number;
  readonly unlockedTypes: readonly KissType[];
}

function adjacentPairExists(
  fen: string,
  color: PlayerColor,
  type: KissType,
): boolean {
  const pieces = parseFenPieces(fen).filter(
    (piece) => piece.color === color && piece.type === type,
  );
  return pieces.some((piece, index) =>
    pieces.slice(index + 1).some(
      (candidate) => areAdjacent(piece.square, candidate.square),
    ),
  );
}

export const nowKissRule: DrawbackRule<
  NowKissState,
  NoParameters
> = {
  id: "now-kiss",
  name: "Now Kiss",
  description:
    "Bishops, knights, and rooks cannot capture until two surviving own pieces of that type have ended a turn adjacent; each family unlocks permanently.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
    // A past adjacency cannot be reconstructed from only final FEN + moves.
    // Imported midgame sessions must supply persisted state to preserve it.
    unlockedTypes: [],
  }),
  filterLegalMoves: (context, moves) => {
    const unlocked = new Set(context.state.unlockedTypes);
    return moves.filter(
      (move) =>
        !isCapture(move) ||
        !KISS_TYPES.includes(move.piece as KissType) ||
        unlocked.has(move.piece as KissType),
    );
  },
  applyMove: (context) => {
    const unlocked = new Set(context.state.unlockedTypes);
    for (const type of KISS_TYPES) {
      if (
        adjacentPairExists(
          context.positionAfterMove.fen,
          context.color,
          type,
        )
      ) {
        unlocked.add(type);
      }
    }
    return {
      movesApplied: context.state.movesApplied + 1,
      unlockedTypes: KISS_TYPES.filter((type) => unlocked.has(type)),
    };
  },
  checkStartOfTurnLoss: () => null,
};

function eraseRule<State>(
  rule: DrawbackRule<State, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const remainingStatefulRules: readonly DrawbackRule<
  unknown,
  NoParameters
>[] = [
  friendlyFireRule,
  protectedPawnsRule,
  rookOnTheSeventhRule,
  risingWaterRule,
  queenDisguiseRule,
  nowKissRule,
].map(eraseRule);
