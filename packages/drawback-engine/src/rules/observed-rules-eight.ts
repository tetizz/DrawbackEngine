import type { PlayerColor } from "@drawbackengine/shared";
import {
  isSquareAttackedAfterMove,
  parseFenPieces,
  projectPiecesAfterMove,
} from "../board-analysis.js";
import type {
  ChessMove,
  DrawbackLoss,
  DrawbackRule,
  PieceType,
  PromotionPiece,
} from "../types.js";
import {
  isCapture,
  manhattanDistance,
  squareCoordinates,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

function isDiagonal(move: Pick<ChessMove, "from" | "to">): boolean {
  const from = squareCoordinates(move.from);
  const to = squareCoordinates(move.to);
  const fileDistance = Math.abs(to.file - from.file);
  const rankDistance = Math.abs(to.rank - from.rank);
  return fileDistance > 0 && fileDistance === rankDistance;
}

function isOrthogonal(move: Pick<ChessMove, "from" | "to">): boolean {
  const from = squareCoordinates(move.from);
  const to = squareCoordinates(move.to);
  return (from.file === to.file) !== (from.rank === to.rank);
}

function fanClubRule(configuration: {
  readonly id: string;
  readonly name: string;
  readonly promotion: PromotionPiece;
  readonly royalMoveAllowed: (move: ChessMove) => boolean;
  readonly description: string;
}): DrawbackRule<StatelessRuleState, NoParameters> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    verification: "implemented-unverified",
    generateParameters: () => ({}),
    initialize: (context) => ({
      movesApplied: context.position.history.filter(
        (move) => move.color === context.color,
      ).length,
    }),
    filterLegalMoves: (_context, moves) =>
      moves.filter(
        (move) =>
          (move.promotion === undefined ||
            move.promotion === configuration.promotion) &&
          (
            (move.piece !== "king" && move.piece !== "queen") ||
            configuration.royalMoveAllowed(move)
          ),
      ),
    applyMove: (context) => ({
      movesApplied: context.state.movesApplied + 1,
    }),
    checkStartOfTurnLoss: () => null,
  };
}

export const bishopFanClubRule = fanClubRule({
  id: "bishop-fan-club",
  name: "Bishop Fan Club",
  promotion: "bishop",
  royalMoveAllowed: isDiagonal,
  description:
    "Every promotion must create a bishop, and primary king and queen moves must be diagonal.",
});

export const rookFanClubRule = fanClubRule({
  id: "rook-fan-club",
  name: "Rook Fan Club",
  promotion: "rook",
  royalMoveAllowed: isOrthogonal,
  description:
    "Every promotion must create a rook, and primary king and queen moves must be orthogonal.",
});

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function moveGivesCheck(fen: string, move: ChessMove): boolean {
  const enemy = opposite(move.color);
  const enemyKing = projectPiecesAfterMove(fen, move).find(
    (piece) => piece.color === enemy && piece.type === "king",
  );
  if (enemyKing === undefined) {
    throw new RangeError("Projected position does not contain the opponent king.");
  }
  return isSquareAttackedAfterMove(
    fen,
    move,
    enemyKing.square,
    move.color,
  );
}

export const respectfulRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "respectful",
  name: "Respectful",
  description: "The affected player cannot make a move that gives check.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
  }),
  filterLegalMoves: (context, moves) =>
    moves.filter((move) => !moveGivesCheck(context.position.fen, move)),
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
};

export type ShapeshifterMode =
  | "bishop"
  | "rook"
  | "queen"
  | "king"
  | "frozen";

export interface ShapeshifterState {
  readonly movesApplied: number;
  readonly trackedSquare: string | null;
  readonly mode: ShapeshifterMode;
}

function modeFromCaptured(type: PieceType): ShapeshifterMode {
  return type === "knight" ? "frozen" : type as ShapeshifterMode;
}

function liveOriginalQueen(
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

function reconstructShapeshifter(
  color: PlayerColor,
  history: readonly ChessMove[],
): Pick<ShapeshifterState, "trackedSquare" | "mode"> {
  let trackedSquare: string | null = color === "white" ? "d1" : "d8";
  let mode: ShapeshifterMode = "bishop";
  for (const move of history) {
    if (
      trackedSquare !== null &&
      move.color === color &&
      move.piece === "queen" &&
      move.from === trackedSquare
    ) {
      trackedSquare = move.to;
    } else if (
      trackedSquare !== null &&
      move.color !== color &&
      isCapture(move) &&
      move.to === trackedSquare
    ) {
      trackedSquare = null;
    }
    if (
      move.color === color &&
      move.captured !== undefined &&
      move.captured !== "pawn"
    ) {
      mode = modeFromCaptured(move.captured);
    }
  }
  return { trackedSquare, mode };
}

function shapeshifterMoveAllowed(
  mode: ShapeshifterMode,
  move: ChessMove,
): boolean {
  switch (mode) {
    case "bishop":
      return isDiagonal(move);
    case "rook":
      return isOrthogonal(move);
    case "queen":
      return isDiagonal(move) || isOrthogonal(move);
    case "king": {
      const from = squareCoordinates(move.from);
      const to = squareCoordinates(move.to);
      return Math.max(
        Math.abs(to.file - from.file),
        Math.abs(to.rank - from.rank),
      ) === 1;
    }
    case "frozen":
      return false;
  }
}

export const shapeshifterRule: DrawbackRule<
  ShapeshifterState,
  NoParameters
> = {
  id: "shapeshifter",
  name: "Shapeshifter",
  description:
    "The original queen begins bishop-like and copies each non-pawn type captured by any own piece; copying a knight freezes it.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => {
    const reconstructed = reconstructShapeshifter(
      context.color,
      context.position.history,
    );
    return {
      movesApplied: context.position.history.filter(
        (move) => move.color === context.color,
      ).length,
      trackedSquare: liveOriginalQueen(
        context.position.fen,
        context.color,
        reconstructed.trackedSquare,
      ),
      mode: reconstructed.mode,
    };
  },
  filterLegalMoves: (context, moves) => {
    const tracked = liveOriginalQueen(
      context.position.fen,
      context.color,
      context.state.trackedSquare,
    );
    return moves.filter(
      (move) =>
        tracked === null ||
        move.from !== tracked ||
        shapeshifterMoveAllowed(context.state.mode, move),
    );
  },
  applyMove: (context, move) => {
    const tracked = liveOriginalQueen(
      context.position.fen,
      context.color,
      context.state.trackedSquare,
    );
    return {
      movesApplied: context.state.movesApplied + 1,
      trackedSquare:
        tracked !== null && move.from === tracked ? move.to : tracked,
      mode:
        move.captured !== undefined && move.captured !== "pawn"
          ? modeFromCaptured(move.captured)
          : context.state.mode,
    };
  },
  checkStartOfTurnLoss: () => null,
};

const STANDARD_START_FILES: Readonly<Record<
  Exclude<PieceType, "pawn">,
  readonly string[]
>> = {
  knight: ["b", "g"],
  bishop: ["c", "f"],
  rook: ["a", "h"],
  queen: ["d"],
  king: ["e"],
};

function standardStartFiles(type: PieceType): readonly string[] {
  if (type === "pawn") {
    throw new RangeError("Pawns do not have a non-pawn start-file set.");
  }
  return STANDARD_START_FILES[type];
}

function fischerArrangementSatisfied(
  pieces: ReturnType<typeof parseFenPieces>,
  color: PlayerColor,
): boolean {
  const homeRank = color === "white" ? "1" : "8";
  return pieces
    .filter((piece) => piece.color === color && piece.type !== "pawn")
    .every((piece) => {
      const file = piece.square[0];
      const rank = piece.square[1];
      return file !== undefined &&
        rank === homeRank &&
        !standardStartFiles(piece.type).includes(file);
    });
}

export const fischerRandomRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "fischer-random",
  name: "Fischer Random",
  description:
    "By turn twenty, every surviving own non-pawn piece must occupy the home rank on a file where that type could not have started.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
  }),
  filterLegalMoves: (context, moves) =>
    context.state.movesApplied < 19
      ? [...moves]
      : moves.filter(
          (move) => fischerArrangementSatisfied(
            projectPiecesAfterMove(context.position.fen, move),
            context.color,
          ),
        ),
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: (context): DrawbackLoss | null =>
    context.state.movesApplied >= 20 &&
    !fischerArrangementSatisfied(
      parseFenPieces(context.position.fen),
      context.color,
    )
      ? {
          ruleId: "fischer-random",
          color: context.color,
          reason:
            "The surviving non-pawn pieces did not reach a valid home-rank arrangement by turn twenty.",
        }
      : null,
};

export interface UnspoolingState {
  readonly movesApplied: number;
  readonly distanceUsed: number;
}

function ownMoves(
  history: readonly ChessMove[],
  color: PlayerColor,
): readonly ChessMove[] {
  return history.filter((move) => move.color === color);
}

export const unspoolingRule: DrawbackRule<
  UnspoolingState,
  NoParameters
> = {
  id: "unspooling",
  name: "Unspooling",
  description:
    "The affected player's primary moves have a shared budget of 100 Manhattan-distance units.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => {
    const history = ownMoves(context.position.history, context.color);
    return {
      movesApplied: history.length,
      distanceUsed: history.reduce(
        (total, move) => total + manhattanDistance(move),
        0,
      ),
    };
  },
  filterLegalMoves: (context, moves) =>
    moves.filter(
      (move) =>
        context.state.distanceUsed +
          manhattanDistance(move) <=
        100,
    ),
  applyMove: (context, move) => ({
    movesApplied: context.state.movesApplied + 1,
    distanceUsed: context.state.distanceUsed + manhattanDistance(move),
  }),
  checkStartOfTurnLoss: (context): DrawbackLoss | null =>
    context.state.distanceUsed >= 100
      ? {
          ruleId: "unspooling",
          color: context.color,
          reason: "The 100-unit movement budget has been exhausted.",
        }
      : null,
};

export const OBSERVED_BLINDED_SQUARES = [
  "d4",
  "e4",
  "d5",
  "e5",
] as const;

export interface BlindedByTheSunParameters {
  readonly square: (typeof OBSERVED_BLINDED_SQUARES)[number];
}

export const blindedByTheSunRule: DrawbackRule<
  StatelessRuleState,
  BlindedByTheSunParameters
> = {
  id: "blinded-by-the-sun",
  name: "Blinded by the Sun",
  description:
    "The affected player cannot end a move pseudo-attacking the hidden central square.",
  verification: "implemented-unverified",
  generateParameters: (rng) => {
    const square = OBSERVED_BLINDED_SQUARES[
      rng.integer(OBSERVED_BLINDED_SQUARES.length)
    ];
    if (square === undefined) {
      throw new Error("Blinded-square generation invariant failed.");
    }
    return { square };
  },
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
  }),
  filterLegalMoves: (context, moves) =>
    moves.filter(
      (move) =>
        !isSquareAttackedAfterMove(
          context.position.fen,
          move,
          context.parameters.square,
          context.color,
        ),
    ),
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
};

function eraseRule<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
): DrawbackRule<unknown, unknown> {
  return rule;
}

export const observedRulesEight: readonly DrawbackRule<
  unknown,
  unknown
>[] = Object.freeze([
  eraseRule(bishopFanClubRule),
  eraseRule(rookFanClubRule),
  eraseRule(respectfulRule),
  eraseRule(shapeshifterRule),
  eraseRule(fischerRandomRule),
  eraseRule(unspoolingRule),
  eraseRule(blindedByTheSunRule),
]);
