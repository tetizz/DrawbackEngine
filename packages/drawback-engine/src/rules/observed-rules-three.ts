import type { PlayerColor } from "@drawbackengine/shared";
import { parseFenPieces, type BoardPiece } from "../board-analysis.js";
import type {
  ChessMove,
  DrawbackLoss,
  DrawbackRule,
  RuleLossContext,
  RuleMoveContext,
} from "../types.js";
import {
  isCapture,
  isDarkSquare,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

interface FilterConfiguration {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly permits: (
    context: RuleMoveContext<StatelessRuleState, NoParameters>,
    move: ChessMove,
    pieces: readonly BoardPiece[],
  ) => boolean;
}

function defineContextualFilter(
  configuration: FilterConfiguration,
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

interface LossConfiguration {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly reason: string;
  readonly loses: (
    context: RuleLossContext<StatelessRuleState, NoParameters>,
    pieces: readonly BoardPiece[],
  ) => boolean;
}

function defineObservedLoss(
  configuration: LossConfiguration,
): DrawbackRule<StatelessRuleState, NoParameters> {
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

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function piecesFor(
  pieces: readonly BoardPiece[],
  color: PlayerColor,
): readonly BoardPiece[] {
  return pieces.filter((piece) => piece.color === color);
}

function fileSide(square: string): "queenside" | "kingside" {
  return "abcd".includes(square[0] ?? "")
    ? "queenside"
    : "kingside";
}

export const luckyRule = defineContextualFilter({
  id: "lucky",
  name: "Lucky",
  description: "No drawback.",
  permits: () => true,
});

export const eisoptrophobiaRule = defineContextualFilter({
  id: "eisoptrophobia",
  name: "Eisoptrophobia",
  description: "A piece cannot capture an opposing piece of the same type.",
  permits: (_context, move) =>
    !isCapture(move) || move.captured !== move.piece,
});

export const gloomstalkerRule = defineContextualFilter({
  id: "gloomstalker",
  name: "Gloomstalker",
  description: "Captures may only be made from dark squares.",
  permits: (_context, move) =>
    !isCapture(move) || isDarkSquare(move.from),
});

const ROYAL_TYPES = new Set(["king", "queen"]);

export const noblesseObligeRule = defineContextualFilter({
  id: "noblesse-oblige",
  name: "Noblesse Oblige",
  description: "Kings and queens may capture only kings or queens.",
  permits: (_context, move) =>
    !isCapture(move) ||
    !ROYAL_TYPES.has(move.piece) ||
    (move.captured !== undefined && ROYAL_TYPES.has(move.captured)),
});

export const bongcloudRule = defineContextualFilter({
  id: "bongcloud",
  name: "Bongcloud",
  description:
    "While the affected player's king is on its back rank, only pawns and kings may move.",
  permits: (context, move, pieces) => {
    const backRank = context.color === "white" ? "1" : "8";
    const kingOnBackRank = pieces.some(
      (piece) =>
        piece.color === context.color &&
        piece.type === "king" &&
        piece.square[1] === backRank,
    );
    return !kingOnBackRank || move.piece === "pawn" || move.piece === "king";
  },
});

export const eatYourVegetablesRule = defineContextualFilter({
  id: "eat-your-vegetables",
  name: "Eat Your Vegetables",
  description:
    "Until the opponent has at most four pawns, only pawns may be captured.",
  permits: (context, move, pieces) => {
    const opponentPawnCount = piecesFor(pieces, opposite(context.color))
      .filter(({ type }) => type === "pawn").length;
    return opponentPawnCount <= 4 ||
      !isCapture(move) ||
      move.captured === "pawn";
  },
});

export const horseEatsFirstRule = defineContextualFilter({
  id: "horse-eats-first",
  name: "Horse Eats First",
  description:
    "While the affected player has a knight, only knights may capture.",
  permits: (context, move, pieces) => {
    const hasKnight = piecesFor(pieces, context.color)
      .some(({ type }) => type === "knight");
    return !hasKnight || !isCapture(move) || move.piece === "knight";
  },
});

export const messyDivorceRule = defineContextualFilter({
  id: "messy-divorce",
  name: "Messy Divorce",
  description:
    "Pieces cannot cross between the queenside files a-d and kingside files e-h.",
  permits: (_context, move) => fileSide(move.from) === fileSide(move.to),
});

export const bodySnatcherRule = defineObservedLoss({
  id: "body-snatcher",
  name: "Body Snatcher",
  description:
    "The affected player loses when the opponent captures a non-pawn piece with an equivalent piece.",
  reason: "The opponent captured a non-pawn piece with the same piece type.",
  loses: (context) => context.position.history.some(
    (move) =>
      move.color === opposite(context.color) &&
      move.captured !== undefined &&
      move.captured !== "pawn" &&
      move.captured === move.piece,
  ),
});

export const castleDoctrineRule = defineObservedLoss({
  id: "castle-doctrine",
  name: "Castle Doctrine",
  description: "The affected player loses when the opponent captures a rook.",
  reason: "The opponent captured a rook.",
  loses: (context) => context.position.history.some(
    (move) =>
      move.color === opposite(context.color) &&
      move.captured === "rook",
  ),
});

export const myKingdomForAHorseRule = defineObservedLoss({
  id: "my-kingdom-for-a-horse",
  name: "My Kingdom for a Horse",
  description: "The affected player loses when the opponent captures a knight.",
  reason: "The opponent captured a knight.",
  loses: (context) => context.position.history.some(
    (move) =>
      move.color === opposite(context.color) &&
      move.captured === "knight",
  ),
});

export const octomomRule = defineObservedLoss({
  id: "octomom",
  name: "Octomom",
  description:
    "The affected player loses after the opponent captures eight of their pieces.",
  reason: "The opponent has captured eight of the affected player's pieces.",
  loses: (context) => context.position.history.filter(
    (move) =>
      move.color === opposite(context.color) &&
      move.captured !== undefined,
  ).length >= 8,
});

export const pawnBattleRule = defineObservedLoss({
  id: "pawn-battle",
  name: "Pawn Battle",
  description:
    "The affected player loses when they have fewer pawns than the opponent.",
  reason: "The affected player has fewer pawns than the opponent.",
  loses: (context, pieces) => {
    const ownPawns = piecesFor(pieces, context.color)
      .filter(({ type }) => type === "pawn").length;
    const opponentPawns = piecesFor(pieces, opposite(context.color))
      .filter(({ type }) => type === "pawn").length;
    return ownPawns < opponentPawns;
  },
});

function isRim(square: string): boolean {
  return square[0] === "a" ||
    square[0] === "h" ||
    square[1] === "1" ||
    square[1] === "8";
}

export const edgelordRule = defineObservedLoss({
  id: "edgelord",
  name: "Edgelord",
  description:
    "The affected player must have at least as many pieces on the rim as the opponent.",
  reason: "The affected player has fewer pieces on the rim than the opponent.",
  loses: (context, pieces) => {
    const ownRim = piecesFor(pieces, context.color)
      .filter(({ square }) => isRim(square)).length;
    const opponentRim = piecesFor(pieces, opposite(context.color))
      .filter(({ square }) => isRim(square)).length;
    return ownRim < opponentRim;
  },
});

export const botezGambitRule = defineObservedLoss({
  id: "botez-gambit",
  name: "Botez Gambit",
  description:
    "At the start of the affected player's eleventh turn, they must have no queen while the opponent still has a queen.",
  reason:
    "The turn-eleven queen condition was not satisfied.",
  loses: (context, pieces) => {
    const fullmove = Number(context.position.fen.split(/\s+/u)[5]);
    if (!Number.isInteger(fullmove) || fullmove < 1) {
      throw new RangeError("FEN must contain a positive fullmove number.");
    }
    if (fullmove !== 11) {
      return false;
    }
    const ownQueen = piecesFor(pieces, context.color)
      .some(({ type }) => type === "queen");
    const opponentQueen = piecesFor(pieces, opposite(context.color))
      .some(({ type }) => type === "queen");
    return ownQueen || !opponentQueen;
  },
});

function eraseObservedRule(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const observedRulesThree: readonly DrawbackRule<unknown, NoParameters>[] =
  [
    luckyRule,
    eisoptrophobiaRule,
    gloomstalkerRule,
    noblesseObligeRule,
    bongcloudRule,
    eatYourVegetablesRule,
    horseEatsFirstRule,
    messyDivorceRule,
    bodySnatcherRule,
    castleDoctrineRule,
    myKingdomForAHorseRule,
    octomomRule,
    pawnBattleRule,
    edgelordRule,
    botezGambitRule,
  ].map(eraseObservedRule);
