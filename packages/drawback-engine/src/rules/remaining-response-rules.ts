import type { PlayerColor } from "@drawbackengine/shared";
import {
  areAdjacent,
  isInCheck,
  isSquareAttacked,
  parseFenPieces,
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
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function lastMoveBy(
  history: readonly ChessMove[],
  color: PlayerColor,
): ChessMove | undefined {
  return [...history].reverse().find((move) => move.color === color);
}

function forceWhenAvailable(
  moves: readonly ChessMove[],
  predicate: (move: ChessMove) => boolean,
): readonly ChessMove[] {
  const forced = moves.filter(predicate);
  return forced.length === 0 ? moves : forced;
}

function defineResponse(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly filter: (
    context: RuleMoveContext<StatelessRuleState, NoParameters>,
    moves: readonly ChessMove[],
  ) => readonly ChessMove[];
  readonly loses?: (
    context: RuleLossContext<StatelessRuleState, NoParameters>,
  ) => string | null;
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
    checkStartOfTurnLoss: (context): DrawbackLoss | null => {
      const reason = configuration.loses?.(context) ?? null;
      return reason === null
        ? null
        : { ruleId: configuration.id, color: context.color, reason };
    },
  };
}

function capturedSquare(move: ChessMove): string {
  return move.flags.split(",").includes("en-passant")
    ? `${move.to[0] ?? ""}${move.from[1] ?? ""}`
    : move.to;
}

export const atomicBombRule = defineResponse({
  id: "atomic-bomb",
  name: "Atomic Bomb",
  description:
    "The affected player loses after the opponent captures a piece whose capture square was adjacent to the affected king.",
  filter: (_context, moves) => moves,
  loses: (context) => {
    const previous = context.position.history.at(-1);
    if (
      previous === undefined ||
      previous.color !== opposite(context.color) ||
      !isCapture(previous)
    ) {
      return null;
    }
    const king = parseFenPieces(context.position.fen).find(
      (piece) => piece.color === context.color && piece.type === "king",
    );
    if (king === undefined) {
      throw new RangeError(`FEN does not contain a ${context.color} king.`);
    }
    return areAdjacent(capturedSquare(previous), king.square)
      ? "The opponent captured a piece adjacent to the affected king."
      : null;
  },
});

export const getDownMrPresidentRule = defineResponse({
  id: "get-down-mr-president",
  name: "Get Down Mr. President",
  description:
    "While in check, the affected player's primary king cannot move.",
  filter: (context, moves) =>
    isInCheck(context.position.fen, context.color)
      ? moves.filter(({ piece }) => piece !== "king")
      : moves,
});

export const guerillaTacticsRule = defineResponse({
  id: "guerilla-tactics",
  name: "Guerilla Tactics",
  description:
    "After an affected-player capture, the same physical piece must return to its previous origin if an ordinary legal return is available.",
  filter: (context, moves) => {
    const previous = lastMoveBy(context.position.history, context.color);
    return previous === undefined || !isCapture(previous)
      ? moves
      : forceWhenAvailable(
          moves,
          (move) =>
            move.from === previous.to && move.to === previous.from,
        );
  },
});

export const princeCharmingRule = defineResponse({
  id: "prince-charming",
  name: "Prince Charming",
  description:
    "If any own queen is attacked and a knight has an ordinary legal move, the affected player must move a knight.",
  filter: (context, moves) => {
    const attackedQueen = parseFenPieces(context.position.fen).some(
      (piece) =>
        piece.color === context.color &&
        piece.type === "queen" &&
        isSquareAttacked(
          context.position.fen,
          piece.square,
          opposite(context.color),
        ),
    );
    return attackedQueen
      ? forceWhenAvailable(moves, ({ piece }) => piece === "knight")
      : moves;
  },
});

export const saviorComplexRule = defineResponse({
  id: "savior-complex",
  name: "Savior Complex",
  description:
    "While in check, every legal response must use a primary queen mover.",
  filter: (context, moves) =>
    isInCheck(context.position.fen, context.color)
      ? moves.filter(({ piece }) => piece === "queen")
      : moves,
});

export const shellshockedRule = defineResponse({
  id: "shellshocked",
  name: "Shellshocked",
  description:
    "After an opponent capture, affected-player pieces adjacent to the captured piece's square cannot move for one turn.",
  filter: (context, moves) => {
    const previous = context.position.history.at(-1);
    if (
      previous === undefined ||
      previous.color !== opposite(context.color) ||
      !isCapture(previous)
    ) {
      return moves;
    }
    const blast = capturedSquare(previous);
    return moves.filter((move) => {
      if (areAdjacent(move.from, blast)) {
        return false;
      }
      if (!move.flags.includes("castle")) {
        return true;
      }
      const rookOrigin = move.to.startsWith("g")
        ? `h${move.from[1] ?? ""}`
        : `a${move.from[1] ?? ""}`;
      return !areAdjacent(rookOrigin, blast);
    });
  },
});

export const skittishRule = defineResponse({
  id: "skittish",
  name: "Skittish",
  description:
    "While in check, every legal response must use the primary king.",
  filter: (context, moves) =>
    isInCheck(context.position.fen, context.color)
      ? moves.filter(({ piece }) => piece === "king")
      : moves,
});

export const sleepyKingRule = defineResponse({
  id: "sleepy-king",
  name: "Sleepy King",
  description:
    "The primary king can move only while the affected player is in check.",
  filter: (context, moves) =>
    isInCheck(context.position.fen, context.color)
      ? moves
      : moves.filter(({ piece }) => piece !== "king"),
});

export const threeCheckRule = defineResponse({
  id: "three-check",
  name: "Three Check",
  description:
    "The affected player loses after the opponent has delivered three checks.",
  filter: (_context, moves) => moves,
  loses: (context) =>
    context.position.history.filter(
      (move) =>
        move.color === opposite(context.color) &&
        /[+#]$/u.test(move.san),
    ).length >= 3
      ? "The opponent has delivered three checks."
      : null,
});

function eraseRule(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const remainingResponseRules: readonly DrawbackRule<
  unknown,
  NoParameters
>[] = [
  atomicBombRule,
  getDownMrPresidentRule,
  guerillaTacticsRule,
  princeCharmingRule,
  saviorComplexRule,
  shellshockedRule,
  skittishRule,
  sleepyKingRule,
  threeCheckRule,
].map(eraseRule);
