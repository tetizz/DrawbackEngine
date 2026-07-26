import type {
  ChessMove,
  DrawbackRule,
  PieceType,
  RuleEvidence,
} from "../types.js";
import {
  defineMoveFilterRule,
  isCapture,
  isDarkSquare,
  manhattanDistance,
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

function evidence(
  ruleId: string,
  message: string,
  move: ChessMove,
): readonly RuleEvidence[] {
  return [{ ruleId, kind: "eliminated", message, move }];
}

export const greedyRule = defineMoveFilterRule({
  id: "greedy",
  name: "Greedy",
  description:
    "A capture is forbidden when an ordinary legal capture of a higher-value piece exists.",
  dependsOnMoveSet: true,
  permits: (move, moves) => {
    if (move.captured === undefined) {
      return true;
    }
    const highest = Math.max(
      ...moves.map((candidate) =>
        candidate.captured === undefined ? 0 : PIECE_VALUE[candidate.captured],
      ),
    );
    return PIECE_VALUE[move.captured] >= highest;
  },
  rejection: (move) => `${move.san} captures below the available maximum value.`,
});

export const professionalCourtesyRule = defineMoveFilterRule({
  id: "professional-courtesy",
  name: "Professional Courtesy",
  description:
    "A non-pawn piece cannot capture an opposing non-pawn piece of the same type.",
  permits: (move) =>
    move.captured === undefined ||
    move.captured === "pawn" ||
    move.piece !== move.captured,
  rejection: (move) => `${move.san} is a forbidden same-type capture.`,
});

export const snipersRule = defineMoveFilterRule({
  id: "snipers",
  name: "Snipers",
  description:
    "A bishop can capture only from at least four diagonal squares away.",
  permits: (move) =>
    move.piece !== "bishop" ||
    !isCapture(move) ||
    manhattanDistance(move) >= 8,
  rejection: (move) => `${move.san} is a bishop capture from fewer than four diagonal squares.`,
});

export const stayAtHomeMomRule = defineMoveFilterRule({
  id: "stay-at-home-mom",
  name: "Stay at Home Mom",
  description: "Queens can move only to the affected player's two home ranks.",
  permits: (move) => {
    if (move.piece !== "queen") {
      return true;
    }
    const rank = squareCoordinates(move.to).rank;
    return move.color === "white" ? rank <= 2 : rank >= 7;
  },
  rejection: (move) => `${move.san} moves a queen beyond its two home ranks.`,
});

export const elephantsFearMiceRule = defineMoveFilterRule({
  id: "elephants-fear-mice",
  name: "Elephants Fear Mice",
  description: "Non-pawn pieces cannot capture opposing pawns.",
  permits: (move) => move.captured !== "pawn" || move.piece === "pawn",
  rejection: (move) => `${move.san} captures a pawn with a non-pawn piece.`,
});

export const farSightedRule = defineMoveFilterRule({
  id: "far-sighted",
  name: "Far Sighted",
  description: "Pieces cannot capture an adjacent target.",
  permits: (move) => !isCapture(move) || travelDistance(move) > 1,
  rejection: (move) => `${move.san} captures an adjacent target.`,
});

export const whitesOfTheirEyesRule = defineMoveFilterRule({
  id: "whites-of-their-eyes",
  name: "Whites of Their Eyes",
  description: "Capturing moves can have Manhattan distance at most two.",
  permits: (move) => !isCapture(move) || manhattanDistance(move) <= 2,
  rejection: (move) => `${move.san} is a capture with Manhattan distance above two.`,
});

export const champingAtTheBitRule = defineMoveFilterRule({
  id: "champing-at-the-bit",
  name: "Champing at the Bit",
  description: "Every pawn move must have Manhattan distance exactly two.",
  permits: (move) => move.piece !== "pawn" || manhattanDistance(move) === 2,
  rejection: (move) => `${move.san} is a pawn move whose Manhattan distance is not two.`,
});

export const scentOfBloodRule = defineMoveFilterRule({
  id: "scent-of-blood",
  name: "The Scent of Blood",
  description:
    "A piece that has an ordinary legal capture cannot make a non-capturing move.",
  dependsOnMoveSet: true,
  permits: (move, moves) =>
    isCapture(move) ||
    !moves.some((candidate) => candidate.from === move.from && isCapture(candidate)),
  rejection: (move) => `${move.san} declines a capture available to that physical piece.`,
});

export const indecisiveRule = defineMoveFilterRule({
  id: "indecisive",
  name: "Indecisive",
  description:
    "A piece cannot capture when it has more than one ordinary legal capturing move.",
  dependsOnMoveSet: true,
  permits: (move, moves) =>
    !isCapture(move) ||
    moves.filter((candidate) => candidate.from === move.from && isCapture(candidate))
      .length <= 1,
  rejection: (move) => `${move.san} captures despite that piece having multiple capture choices.`,
});

export const controlCenterRule = defineMoveFilterRule({
  id: "control-center",
  name: "Control Center",
  description: "Non-capturing moves must end on one of the four central files.",
  permits: (move) =>
    isCapture(move) || ["c", "d", "e", "f"].includes(move.to[0] ?? ""),
  rejection: (move) => `${move.san} is a quiet move outside the four central files.`,
});

export interface OutOfBreathState {
  readonly kingMoves: number;
}

export const outOfBreathRule: DrawbackRule<
  OutOfBreathState,
  NoParameters
> = {
  id: "out-of-breath",
  name: "Out of Breath",
  description: "The affected player can move a king only once.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: () => ({ kingMoves: 0 }),
  filterLegalMoves: (context, moves) =>
    context.state.kingMoves === 0
      ? [...moves]
      : moves.filter((move) => move.piece !== "king"),
  applyMove: (context, move) => ({
    kingMoves: context.state.kingMoves + (move.piece === "king" ? 1 : 0),
  }),
  checkStartOfTurnLoss: () => null,
  explainMove: (context, move) =>
    context.state.kingMoves > 0 && move.piece === "king"
      ? evidence("out-of-breath", `${move.san} would be a second king move.`, move)
      : [],
};

export interface QueenBeeState {
  readonly queenCaptureOccurred: boolean;
}

export const queenBeeRule: DrawbackRule<QueenBeeState, NoParameters> = {
  id: "queen-bee",
  name: "Queen Bee",
  description: "After capturing with a queen, the affected player can no longer move queens.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: () => ({ queenCaptureOccurred: false }),
  filterLegalMoves: (context, moves) =>
    context.state.queenCaptureOccurred
      ? moves.filter((move) => move.piece !== "queen")
      : [...moves],
  applyMove: (context, move) => ({
    queenCaptureOccurred:
      context.state.queenCaptureOccurred ||
      (move.piece === "queen" && isCapture(move)),
  }),
  checkStartOfTurnLoss: () => null,
  explainMove: (context, move) =>
    context.state.queenCaptureOccurred && move.piece === "queen"
      ? evidence("queen-bee", `${move.san} moves a frozen queen.`, move)
      : [],
};

export interface AlternationState {
  readonly previousClass: boolean | null;
}

function defineAlternationRule(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly classify: (move: ChessMove) => boolean;
  readonly classNames: readonly [string, string];
}): DrawbackRule<AlternationState, NoParameters> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    verification: "implemented-unverified",
    generateParameters: () => ({}),
    initialize: () => ({ previousClass: null }),
    filterLegalMoves: (context, moves) =>
      context.state.previousClass === null
        ? [...moves]
        : moves.filter(
            (move) => configuration.classify(move) !== context.state.previousClass,
          ),
    applyMove: (_context, move) => ({
      previousClass: configuration.classify(move),
    }),
    checkStartOfTurnLoss: () => null,
    explainMove: (context, move) => {
      const moveClass = configuration.classify(move);
      return context.state.previousClass !== null &&
        moveClass === context.state.previousClass
        ? evidence(
            configuration.id,
            `${move.san} repeats the ${configuration.classNames[moveClass ? 1 : 0]} class.`,
            move,
          )
        : [];
    },
  };
}

export const alternatorRule = defineAlternationRule({
  id: "alternator",
  name: "Alternator",
  description: "Moves must alternate between pawns and non-pawn pieces.",
  classify: (move) => move.piece !== "pawn",
  classNames: ["pawn", "non-pawn"],
});

export const hopscotchRule = defineAlternationRule({
  id: "hopscotch",
  name: "Hopscotch",
  description: "Move destinations must alternate between light and dark squares.",
  classify: (move) => isDarkSquare(move.to),
  classNames: ["light-square", "dark-square"],
});

function eraseCommunityRule<State>(
  rule: DrawbackRule<State, NoParameters>,
): DrawbackRule<unknown, NoParameters> {
  return rule;
}

export const communityRules: readonly DrawbackRule<
  unknown,
  NoParameters
>[] = [
  eraseCommunityRule(greedyRule),
  eraseCommunityRule(professionalCourtesyRule),
  eraseCommunityRule(snipersRule),
  eraseCommunityRule(stayAtHomeMomRule),
  eraseCommunityRule(elephantsFearMiceRule),
  eraseCommunityRule(farSightedRule),
  eraseCommunityRule(whitesOfTheirEyesRule),
  eraseCommunityRule(champingAtTheBitRule),
  eraseCommunityRule(scentOfBloodRule),
  eraseCommunityRule(indecisiveRule),
  eraseCommunityRule(controlCenterRule),
  eraseCommunityRule(outOfBreathRule),
  eraseCommunityRule(queenBeeRule),
  eraseCommunityRule(alternatorRule),
  eraseCommunityRule(hopscotchRule),
];
