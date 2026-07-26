import type {
  ChessMove,
  DrawbackRule,
  PieceType,
  RuleEvidence,
} from "../types.js";
import {
  defineMoveFilterRule,
  isCapture,
  squareCoordinates,
  travelDistance,
  type NoParameters,
} from "./common.js";

const PIECE_VALUE: Readonly<Record<PieceType, number>> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: Number.POSITIVE_INFINITY,
};

function isHeavy(piece: PieceType | undefined): boolean {
  return piece === "rook" || piece === "queen";
}

function isSameTypeCapture(move: ChessMove): boolean {
  return move.captured !== undefined && move.piece === move.captured;
}

function qualifiesForSimplifier(move: ChessMove): boolean {
  return move.captured !== undefined &&
    PIECE_VALUE[move.piece] <= PIECE_VALUE[move.captured];
}

function distinctOriginsTo(
  moves: readonly ChessMove[],
  destination: string,
  capturesOnly: boolean,
): number {
  return new Set(
    moves
      .filter(
        (candidate) =>
          candidate.to === destination &&
          (!capturesOnly || isCapture(candidate)),
      )
      .map(({ from }) => from),
  ).size;
}

export const bottledLightingRule = defineMoveFilterRule({
  id: "bottled-lighting",
  name: "Bottled Lighting",
  description: "If an ordinary legal king move exists, the affected player must move the king.",
  dependsOnMoveSet: true,
  permits: (move, moves) =>
    !moves.some((candidate) => candidate.piece === "king") ||
    move.piece === "king",
  rejection: (move) => `${move.san} declines an available king move.`,
});

export const chivalryRule = defineMoveFilterRule({
  id: "chivalry",
  name: "Chivalry",
  description: "Only a knight can capture an opposing rook or queen.",
  permits: (move) => !isHeavy(move.captured) || move.piece === "knight",
  rejection: (move) => `${move.san} captures a heavy piece without a knight.`,
});

export const coveringFireRule = defineMoveFilterRule({
  id: "covering-fire",
  name: "Covering Fire",
  description:
    "A capture is legal only when the target square can be captured from at least two distinct origins.",
  dependsOnMoveSet: true,
  permits: (move, moves) =>
    !isCapture(move) || distinctOriginsTo(moves, move.to, true) >= 2,
  rejection: (move) => `${move.san} is the only legal way to capture on ${move.to}.`,
});

export const escortMissionRule = defineMoveFilterRule({
  id: "escort-mission",
  name: "Escort Mission",
  description: "If the king has an ordinary legal capture, it must make a capture.",
  dependsOnMoveSet: true,
  permits: (move, moves) => {
    const kingCaptureExists = moves.some(
      (candidate) => candidate.piece === "king" && isCapture(candidate),
    );
    return !kingCaptureExists || (move.piece === "king" && isCapture(move));
  },
  rejection: (move) => `${move.san} declines an available king capture.`,
});

export const evilTwinRule = defineMoveFilterRule({
  id: "evil-twin",
  name: "Evil Twin",
  description:
    "If a piece can capture an opposing piece of the same type, one of those captures is compulsory.",
  dependsOnMoveSet: true,
  permits: (move, moves) =>
    !moves.some(isSameTypeCapture) || isSameTypeCapture(move),
  rejection: (move) => `${move.san} declines an available same-type capture.`,
});

export const exclusivityClauseRule = defineMoveFilterRule({
  id: "exclusivity-clause",
  name: "Exclusivity Clause",
  description:
    "A destination is forbidden when ordinary legal moves from more than one origin can reach it.",
  dependsOnMoveSet: true,
  permits: (move, moves) => distinctOriginsTo(moves, move.to, false) === 1,
  rejection: (move) => `${move.san} shares its destination with another movable piece.`,
});

export const leapsAndBoundsRule = defineMoveFilterRule({
  id: "leaps-and-bounds",
  name: "Leaps and Bounds",
  description: "A piece cannot move to an adjacent square.",
  permits: (move) => travelDistance(move) > 1,
  rejection: (move) => `${move.san} ends adjacent to its origin.`,
});

export const leftForDeadRule = defineMoveFilterRule({
  id: "left-for-dead",
  name: "Left for Dead",
  description: "Captures must move toward the affected player's left.",
  permits: (move) => {
    if (!isCapture(move)) {
      return true;
    }
    const from = squareCoordinates(move.from);
    const to = squareCoordinates(move.to);
    return move.color === "white" ? to.file < from.file : to.file > from.file;
  },
  rejection: (move) => `${move.san} is not a capture toward the player's left.`,
});

function isRim(square: string): boolean {
  const { file, rank } = squareCoordinates(square);
  return file === 1 || file === 8 || rank === 1 || rank === 8;
}

export const outflankedRule = defineMoveFilterRule({
  id: "outflanked",
  name: "Outflanked",
  description: "Captures on a rim square are forbidden.",
  permits: (move) => !isCapture(move) || !isRim(move.to),
  rejection: (move) => `${move.san} captures on the rim.`,
});

export const punchingDownRule = defineMoveFilterRule({
  id: "punching-down",
  name: "Punching Down",
  description: "A piece cannot capture a target worth more than the moving piece.",
  permits: (move) =>
    move.captured === undefined ||
    PIECE_VALUE[move.piece] >= PIECE_VALUE[move.captured],
  rejection: (move) => `${move.san} captures a more valuable piece.`,
});

export const simplifierRule = defineMoveFilterRule({
  id: "simplifier",
  name: "Simplifier",
  description:
    "If a capture by a piece worth no more than its target exists, one of those captures is compulsory.",
  dependsOnMoveSet: true,
  permits: (move, moves) =>
    !moves.some(qualifiesForSimplifier) || qualifiesForSimplifier(move),
  rejection: (move) => `${move.san} declines a qualifying simplifying capture.`,
});

export interface BipartisanshipState {
  readonly previousHorizontalDirection: -1 | 0 | 1;
}

function horizontalDirection(move: ChessMove): -1 | 0 | 1 {
  const from = squareCoordinates(move.from);
  const to = squareCoordinates(move.to);
  return to.file === from.file ? 0 : to.file > from.file ? 1 : -1;
}

export const bipartisanshipRule: DrawbackRule<
  BipartisanshipState,
  NoParameters
> = {
  id: "bipartisanship",
  name: "Bipartisanship",
  description: "The affected player cannot move left twice in a row or right twice in a row.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: () => ({ previousHorizontalDirection: 0 }),
  filterLegalMoves: (context, moves) =>
    moves.filter((move) => {
      const direction = horizontalDirection(move);
      return direction === 0 ||
        direction !== context.state.previousHorizontalDirection;
    }),
  applyMove: (_context, move) => ({
    previousHorizontalDirection: horizontalDirection(move),
  }),
  checkStartOfTurnLoss: () => null,
  explainMove: (context, move): readonly RuleEvidence[] => {
    const direction = horizontalDirection(move);
    return direction !== 0 &&
      direction === context.state.previousHorizontalDirection
      ? [{
          ruleId: "bipartisanship",
          kind: "eliminated",
          message: `${move.san} repeats the previous horizontal direction.`,
          move,
        }]
      : [];
  },
};

function eraseCommunityRule<State>(
  rule: DrawbackRule<State, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const communityRulesTwo: readonly DrawbackRule<
  unknown,
  NoParameters
>[] = [
  eraseCommunityRule(bottledLightingRule),
  eraseCommunityRule(chivalryRule),
  eraseCommunityRule(coveringFireRule),
  eraseCommunityRule(escortMissionRule),
  eraseCommunityRule(evilTwinRule),
  eraseCommunityRule(exclusivityClauseRule),
  eraseCommunityRule(leapsAndBoundsRule),
  eraseCommunityRule(leftForDeadRule),
  eraseCommunityRule(outflankedRule),
  eraseCommunityRule(punchingDownRule),
  eraseCommunityRule(simplifierRule),
  eraseCommunityRule(bipartisanshipRule),
];
