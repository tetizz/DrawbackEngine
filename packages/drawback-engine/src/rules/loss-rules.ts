import type { PlayerColor } from "@drawbackengine/shared";
import {
  areAdjacent,
  isInCheck,
  parseFenPieces,
  type BoardPiece,
} from "../board-analysis.js";
import type {
  ChessMove,
  DrawbackLoss,
  DrawbackRule,
  RuleLossContext,
} from "../types.js";
import type { NoParameters, StatelessRuleState } from "./common.js";

interface LossRuleConfiguration {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly reason: string;
  readonly loses: (
    context: RuleLossContext<StatelessRuleState, NoParameters>,
    pieces: readonly BoardPiece[],
  ) => boolean;
  readonly permits?: (move: ChessMove) => boolean;
}

function defineLossRule(
  configuration: LossRuleConfiguration,
): DrawbackRule<StatelessRuleState, NoParameters> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    verification: "implemented-unverified",
    generateParameters: () => ({}),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (_context, moves) =>
      configuration.permits === undefined
        ? [...moves]
        : moves.filter(configuration.permits),
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

function homeRanks(color: PlayerColor): readonly [number, number] {
  return color === "white" ? [1, 2] : [7, 8];
}

function rankOf(piece: BoardPiece): number {
  return Number(piece.square[1]);
}

export const abstinenceRule = defineLossRule({
  id: "abstinence",
  name: "Abstinence",
  description:
    "The affected player loses when the opponent has two adjacent non-pawn pieces of the same type at the start of the affected player's turn.",
  reason: "The opponent has adjacent non-pawn pieces of the same type.",
  loses: (context, pieces) => {
    const opponents = piecesFor(pieces, opposite(context.color))
      .filter(({ type }) => type !== "pawn");
    return opponents.some((piece, index) =>
      opponents.slice(index + 1).some(
        (candidate) =>
          candidate.type === piece.type &&
          areAdjacent(candidate.square, piece.square),
      ),
    );
  },
});

export const alwaysCheckRule = defineLossRule({
  id: "always-check-it-might-be-mate",
  name: "Always Check, It Might Be Mate",
  description: "The affected player loses if they start a turn in check.",
  reason: "The affected player started the turn in check.",
  loses: (context) => isInCheck(context.position.fen, context.color),
});

export const boastfulRule = defineLossRule({
  id: "boastful",
  name: "Boastful",
  description: "The affected player loses if they have fewer pieces than the opponent.",
  reason: "The affected player has fewer pieces than the opponent.",
  loses: (context, pieces) =>
    piecesFor(pieces, context.color).length <
    piecesFor(pieces, opposite(context.color)).length,
});

export const closedBookRule = defineLossRule({
  id: "closed-book",
  name: "Closed Book",
  description: "The affected player loses if any file contains no pawns.",
  reason: "At least one file is open.",
  loses: (_context, pieces) => {
    const pawnFiles = new Set(
      pieces.filter(({ type }) => type === "pawn")
        .map(({ square }) => square[0]),
    );
    return "abcdefgh".split("").some((file) => !pawnFiles.has(file));
  },
});

export const holdThemBackRule = defineLossRule({
  id: "hold-them-back",
  name: "Hold Them Back",
  description:
    "The affected player loses if an opposing pawn reaches the affected player's half of the board.",
  reason: "An opposing pawn reached the affected player's side of the board.",
  loses: (context, pieces) =>
    piecesFor(pieces, opposite(context.color)).some(
      (piece) =>
        piece.type === "pawn" &&
        (context.color === "white" ? rankOf(piece) <= 4 : rankOf(piece) >= 5),
    ),
});

export const homelandSecurityRule = defineLossRule({
  id: "homeland-security",
  name: "Homeland Security",
  description:
    "The affected player loses if an opposing piece occupies either of their two home ranks.",
  reason: "An opposing piece entered the affected player's starting sixteen squares.",
  loses: (context, pieces) => {
    const ranks = homeRanks(context.color);
    return piecesFor(pieces, opposite(context.color)).some(
      (piece) => ranks.includes(rankOf(piece)),
    );
  },
});

export const ivoryTowerRule = defineLossRule({
  id: "ivory-tower",
  name: "Ivory Tower",
  description: "The affected player loses if an opposing piece is adjacent to their king.",
  reason: "An opposing piece is adjacent to the affected player's king.",
  loses: (context, pieces) => {
    const king = pieces.find(
      (piece) => piece.color === context.color && piece.type === "king",
    );
    if (king === undefined) {
      throw new RangeError(`FEN does not contain a ${context.color} king.`);
    }
    return piecesFor(pieces, opposite(context.color)).some(
      (piece) => areAdjacent(piece.square, king.square),
    );
  },
});

const CENTER = new Set(["d4", "e4", "d5", "e5"]);

export const kingOfTheHillRule = defineLossRule({
  id: "king-of-the-hill",
  name: "King of the Hill",
  description:
    "After the affected player's first turn, they lose if none of their pieces occupies a central square.",
  reason: "The affected player has no piece in the four-square center.",
  loses: (context, pieces) =>
    context.position.history.some((move) => move.color === context.color) &&
    !piecesFor(pieces, context.color).some(({ square }) => CENTER.has(square)),
});

export const modestRule = defineLossRule({
  id: "modest",
  name: "Modest",
  description: "The affected player loses if they have more pieces than the opponent.",
  reason: "The affected player has more pieces than the opponent.",
  loses: (context, pieces) =>
    piecesFor(pieces, context.color).length >
    piecesFor(pieces, opposite(context.color)).length,
});

export const simpRule = defineLossRule({
  id: "simp",
  name: "Simp",
  description: "The affected player loses if they have no queen.",
  reason: "The affected player has no queen.",
  loses: (context, pieces) =>
    !piecesFor(pieces, context.color).some(({ type }) => type === "queen"),
});

export const towerDefenseRule = defineLossRule({
  id: "tower-defense",
  name: "Tower Defense",
  description: "Rooks cannot move, and the affected player loses if they have no rook.",
  reason: "The affected player has no rook.",
  permits: (move) => move.piece !== "rook",
  loses: (context, pieces) =>
    !piecesFor(pieces, context.color).some(({ type }) => type === "rook"),
});

export const warlordRule = defineLossRule({
  id: "warlord",
  name: "Warlord",
  description:
    "From the affected player's twelfth turn onward, their king cannot remain on either home rank.",
  reason: "The king remained on a home rank at the start of turn twelve or later.",
  loses: (context, pieces) => {
    const completedTurns = context.position.history.filter(
      (move) => move.color === context.color,
    ).length;
    if (completedTurns < 11) {
      return false;
    }
    const king = pieces.find(
      (piece) => piece.color === context.color && piece.type === "king",
    );
    if (king === undefined) {
      throw new RangeError(`FEN does not contain a ${context.color} king.`);
    }
    return homeRanks(context.color).includes(rankOf(king));
  },
});

function eraseLossRule(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const lossRules: readonly DrawbackRule<unknown, NoParameters>[] = [
  abstinenceRule,
  alwaysCheckRule,
  boastfulRule,
  closedBookRule,
  holdThemBackRule,
  homelandSecurityRule,
  ivoryTowerRule,
  kingOfTheHillRule,
  modestRule,
  simpRule,
  towerDefenseRule,
  warlordRule,
].map(eraseLossRule);
