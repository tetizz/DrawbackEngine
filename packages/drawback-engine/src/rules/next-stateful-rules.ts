import type { PlayerColor } from "@drawbackengine/shared";
import {
  areAdjacent,
  parseFenPieces,
  type BoardPiece,
} from "../board-analysis.js";
import type {
  ChessMove,
  DrawbackLoss,
  DrawbackRule,
  PieceType,
  RuleLossContext,
} from "../types.js";
import {
  isCapture,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

const CAPTURE_ORDER: readonly PieceType[] = [
  "pawn",
  "knight",
  "bishop",
  "rook",
  "queen",
  "king",
];

function ownMoves(
  history: readonly ChessMove[],
  color: PlayerColor,
): readonly ChessMove[] {
  return history.filter((move) => move.color === color);
}

function piecesFor(
  pieces: readonly BoardPiece[],
  color: PlayerColor,
): readonly BoardPiece[] {
  return pieces.filter((piece) => piece.color === color);
}

function pieceKey(piece: Pick<BoardPiece, "square" | "type">): string {
  return `${piece.type}@${piece.square}`;
}

function castleRookMovement(
  move: ChessMove,
): readonly [string, string] | undefined {
  if (!move.flags.includes("castle")) {
    return undefined;
  }
  const movements: Readonly<Record<string, readonly [string, string]>> = {
    e1g1: ["h1", "f1"],
    e1c1: ["a1", "d1"],
    e8g8: ["h8", "f8"],
    e8c8: ["a8", "d8"],
  };
  const movement = movements[`${move.from}${move.to}`];
  if (movement === undefined) {
    throw new RangeError(
      `Cannot infer secondary rook movement for castling move ${move.from}-${move.to}.`,
    );
  }
  return movement;
}

export interface BloodthirstyState {
  readonly movesApplied: number;
  readonly quietTurnsAfterGrace: number;
}

function reconstructBloodthirsty(
  history: readonly ChessMove[],
  color: PlayerColor,
): BloodthirstyState {
  const moves = ownMoves(history, color);
  let quietTurnsAfterGrace = 0;
  for (const [index, move] of moves.entries()) {
    if (index < 3) {
      continue;
    }
    quietTurnsAfterGrace = isCapture(move)
      ? 0
      : quietTurnsAfterGrace + 1;
  }
  return { movesApplied: moves.length, quietTurnsAfterGrace };
}

export const bloodthirstyRule: DrawbackRule<
  BloodthirstyState,
  NoParameters
> = {
  id: "bloodthirsty",
  name: "Bloodthirsty",
  description:
    "After three grace turns, two consecutive quiet turns force a capture on the next affected-player turn.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) =>
    reconstructBloodthirsty(context.position.history, context.color),
  filterLegalMoves: (context, moves) =>
    context.state.quietTurnsAfterGrace >= 2
      ? moves.filter(isCapture)
      : [...moves],
  applyMove: (context, move) => ({
    movesApplied: context.state.movesApplied + 1,
    quietTurnsAfterGrace: context.state.movesApplied < 3
      ? 0
      : isCapture(move)
        ? 0
        : context.state.quietTurnsAfterGrace + 1,
  }),
  checkStartOfTurnLoss: () => null,
};

export interface FixationFocus {
  readonly category: "pawn" | "non-pawn";
  readonly square: string;
}

export interface FixationState {
  readonly movesApplied: number;
  readonly focus: FixationFocus | null;
}

function category(move: Pick<ChessMove, "piece">): FixationFocus["category"] {
  return move.piece === "pawn" ? "pawn" : "non-pawn";
}

export const fixationRule: DrawbackRule<FixationState, NoParameters> = {
  id: "fixation",
  name: "Fixation",
  description:
    "Within the pawn or non-pawn category, the same physical piece remains focused until a move from the opposite category.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => {
    const history = ownMoves(context.position.history, context.color);
    const previous = history.at(-1);
    return {
      movesApplied: history.length,
      focus: previous === undefined
        ? null
        : { category: category(previous), square: previous.to },
    };
  },
  filterLegalMoves: (context, moves) =>
    context.state.focus === null
      ? [...moves]
      : moves.filter(
          (move) =>
            category(move) !== context.state.focus?.category ||
            move.from === context.state.focus.square,
        ),
  applyMove: (context, move) => ({
    movesApplied: context.state.movesApplied + 1,
    focus: { category: category(move), square: move.to },
  }),
  checkStartOfTurnLoss: () => null,
};

export interface LevelingUpState {
  readonly movesApplied: number;
  readonly captureLevel: number;
}

function advanceCaptureLevel(level: number, move: ChessMove): number {
  if (!isCapture(move) || move.captured === undefined) {
    return level;
  }
  const capturedIndex = CAPTURE_ORDER.indexOf(move.captured);
  return capturedIndex === level
    ? Math.min(level + 1, CAPTURE_ORDER.length)
    : level;
}

export const levelingUpRule: DrawbackRule<
  LevelingUpState,
  NoParameters
> = {
  id: "leveling-up",
  name: "Leveling Up",
  description:
    "Capture targets unlock in order: pawn, knight, bishop, rook, queen, then king.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => {
    const history = ownMoves(context.position.history, context.color);
    return {
      movesApplied: history.length,
      captureLevel: history.reduce(advanceCaptureLevel, 0),
    };
  },
  filterLegalMoves: (context, moves) =>
    moves.filter(
      (move) =>
        !isCapture(move) ||
        (move.captured !== undefined &&
          CAPTURE_ORDER.indexOf(move.captured) <= context.state.captureLevel),
    ),
  applyMove: (context, move) => ({
    movesApplied: context.state.movesApplied + 1,
    captureLevel: advanceCaptureLevel(context.state.captureLevel, move),
  }),
  checkStartOfTurnLoss: () => null,
};

export interface QuicksandState {
  readonly movesApplied: number;
  readonly previousMiddlePieces: readonly string[];
  readonly frozenPieces: readonly string[];
}

function isMiddleRank(square: string): boolean {
  return square.endsWith("4") || square.endsWith("5");
}

function effectiveFrozen(
  state: QuicksandState,
  pieces: readonly BoardPiece[],
  color: PlayerColor,
): ReadonlySet<string> {
  const present = new Set(piecesFor(pieces, color).map(pieceKey));
  return new Set(state.frozenPieces.filter((key) => present.has(key)));
}

export const quicksandRule: DrawbackRule<QuicksandState, NoParameters> = {
  id: "quicksand",
  name: "Quicksand",
  description:
    "An affected piece that ends two consecutive own turns unchanged on rank four or five becomes permanently frozen.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: ownMoves(context.position.history, context.color).length,
    previousMiddlePieces: [],
    frozenPieces: [],
  }),
  filterLegalMoves: (context, moves) => {
    const pieces = parseFenPieces(context.position.fen);
    const frozen = effectiveFrozen(context.state, pieces, context.color);
    return moves.filter((move) => {
      if (frozen.has(`${move.piece}@${move.from}`)) {
        return false;
      }
      const rook = castleRookMovement(move);
      return rook === undefined || !frozen.has(`rook@${rook[0]}`);
    });
  },
  applyMove: (context, move) => {
    const before = parseFenPieces(context.position.fen);
    const after = parseFenPieces(context.positionAfterMove.fen);
    const activeFrozen = effectiveFrozen(context.state, before, context.color);
    const previous = new Set(context.state.previousMiddlePieces);
    const rook = castleRookMovement(move);
    const movedDestinations = new Set([
      move.to,
      ...(rook === undefined ? [] : [rook[1]]),
    ]);
    const currentMiddle = piecesFor(after, context.color)
      .filter(({ square }) => isMiddleRank(square));
    const newlyFrozen = currentMiddle
      .filter(
        (piece) =>
          !movedDestinations.has(piece.square) &&
          previous.has(pieceKey(piece)),
      )
      .map(pieceKey);
    return {
      movesApplied: context.state.movesApplied + 1,
      previousMiddlePieces: currentMiddle.map(pieceKey),
      frozenPieces: [...new Set([...activeFrozen, ...newlyFrozen])],
    };
  },
  checkStartOfTurnLoss: () => null,
};

export interface DirtyPiece {
  readonly square: string;
  readonly type: PieceType;
}

export interface AbsolutionState {
  readonly movesApplied: number;
  readonly dirtyPieces: readonly DirtyPiece[];
}

function effectiveDirty(
  state: AbsolutionState,
  pieces: readonly BoardPiece[],
  color: PlayerColor,
): readonly DirtyPiece[] {
  const own = piecesFor(pieces, color);
  const bishops = own.filter(({ type }) => type === "bishop");
  return state.dirtyPieces.filter(
    (dirty) =>
      own.some(
        (piece) =>
          piece.square === dirty.square && piece.type === dirty.type,
      ) &&
      !bishops.some((bishop) => areAdjacent(dirty.square, bishop.square)),
  );
}

export const absolutionRule: DrawbackRule<
  AbsolutionState,
  NoParameters
> = {
  id: "absolution",
  name: "Absolution",
  description:
    "After a non-bishop captures, that physical piece cannot capture again until it starts a later turn adjacent to an own bishop.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: ownMoves(context.position.history, context.color).length,
    dirtyPieces: [],
  }),
  filterLegalMoves: (context, moves) => {
    const dirty = effectiveDirty(
      context.state,
      parseFenPieces(context.position.fen),
      context.color,
    );
    return moves.filter(
      (move) =>
        !isCapture(move) ||
        !dirty.some(
          (piece) =>
            piece.square === move.from && piece.type === move.piece,
        ),
    );
  },
  applyMove: (context, move) => {
    const pieces = parseFenPieces(context.position.fen);
    const rookMovement = castleRookMovement(move);
    const dirty = effectiveDirty(context.state, pieces, context.color)
      .map((piece) =>
        piece.square === move.from && piece.type === move.piece
          ? {
              square: move.to,
              type: move.promotion ?? move.piece,
            }
          : rookMovement !== undefined &&
              piece.square === rookMovement[0] &&
              piece.type === "rook"
            ? {
                square: rookMovement[1],
                type: "rook" as const,
              }
          : piece,
      );
    if (isCapture(move) && move.piece !== "bishop") {
      const resulting = {
        square: move.to,
        type: move.promotion ?? move.piece,
      };
      const withoutDuplicate = dirty.filter(
        (piece) =>
          piece.square !== resulting.square ||
          piece.type !== resulting.type,
      );
      dirty.splice(0, dirty.length, ...withoutDuplicate, resulting);
    }
    return {
      movesApplied: context.state.movesApplied + 1,
      dirtyPieces: dirty,
    };
  },
  checkStartOfTurnLoss: () => null,
};

function completedOwnTurns<State>(
  context: RuleLossContext<State, NoParameters>,
): number {
  return ownMoves(context.position.history, context.color).length;
}

function defineDeadlineLoss(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly reason: string;
  readonly loses: (
    context: RuleLossContext<StatelessRuleState, NoParameters>,
    ownPieces: readonly BoardPiece[],
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
      configuration.loses(
        context,
        piecesFor(parseFenPieces(context.position.fen), context.color),
      )
        ? {
            ruleId: configuration.id,
            color: context.color,
            reason: configuration.reason,
          }
        : null,
  };
}

export const movingDayRule = defineDeadlineLoss({
  id: "moving-day",
  name: "Moving Day",
  description:
    "At the start of the twenty-first affected-player turn and later, no own piece may remain on its home rank.",
  reason: "An own piece remained on the home rank after the move-twenty deadline.",
  loses: (context, pieces) => {
    if (completedOwnTurns(context) < 20) {
      return false;
    }
    const homeRank = context.color === "white" ? "1" : "8";
    return pieces.some(({ square }) => square.endsWith(homeRank));
  },
});

export const siegeRule = defineDeadlineLoss({
  id: "siege",
  name: "Siege",
  description:
    "By the start of the twenty-first affected-player turn, the affected player must have captured a rook.",
  reason: "No opposing rook was captured by the move-twenty deadline.",
  loses: (context) =>
    completedOwnTurns(context) >= 20 &&
    !ownMoves(context.position.history, context.color)
      .some(({ captured }) => captured === "rook"),
});

function eraseRule<State>(
  rule: DrawbackRule<State, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const nextStatefulRules: readonly DrawbackRule<
  unknown,
  NoParameters
>[] = [
  eraseRule(bloodthirstyRule),
  eraseRule(fixationRule),
  eraseRule(levelingUpRule),
  eraseRule(quicksandRule),
  eraseRule(absolutionRule),
  eraseRule(movingDayRule),
  eraseRule(siegeRule),
];
