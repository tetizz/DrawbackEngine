import type {
  ChessMove,
  DrawbackRule,
  RuleEvidence,
} from "../types.js";

export type NoParameters = Record<string, never>;

export interface StatelessRuleState {
  readonly movesApplied: number;
}

export interface SquareCoordinates {
  readonly file: number;
  readonly rank: number;
}

export function squareCoordinates(square: string): SquareCoordinates {
  if (!/^[a-h][1-8]$/.test(square)) {
    throw new RangeError(`Invalid chess square: ${square}.`);
  }
  return {
    file: square.charCodeAt(0) - "a".charCodeAt(0) + 1,
    rank: Number(square[1]),
  };
}

export function manhattanDistance(move: Pick<ChessMove, "from" | "to">): number {
  const from = squareCoordinates(move.from);
  const to = squareCoordinates(move.to);
  return Math.abs(to.file - from.file) + Math.abs(to.rank - from.rank);
}

export function travelDistance(move: Pick<ChessMove, "from" | "to">): number {
  const from = squareCoordinates(move.from);
  const to = squareCoordinates(move.to);
  return Math.max(
    Math.abs(to.file - from.file),
    Math.abs(to.rank - from.rank),
  );
}

export function isDarkSquare(square: string): boolean {
  const coordinates = squareCoordinates(square);
  return (coordinates.file + coordinates.rank) % 2 === 0;
}

export function isCapture(move: ChessMove): boolean {
  return move.captured !== undefined || move.flags.split(",").includes("en-passant");
}

export function defineMoveFilterRule(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly dependsOnMoveSet?: boolean;
  readonly supportedAuthorities?: DrawbackRule<
    StatelessRuleState,
    NoParameters
  >["supportedAuthorities"];
  readonly permits: (move: ChessMove, moves: readonly ChessMove[]) => boolean;
  readonly rejection: (move: ChessMove) => string;
}): DrawbackRule<StatelessRuleState, NoParameters> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    verification: "implemented-unverified",
    ...(configuration.supportedAuthorities === undefined
      ? {}
      : { supportedAuthorities: configuration.supportedAuthorities }),
    generateParameters: () => ({}),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (_context, moves) =>
      moves.filter((move) => configuration.permits(move, moves)),
    applyMove: (context) => ({
      movesApplied: context.state.movesApplied + 1,
    }),
    checkStartOfTurnLoss: () => null,
    explainMove: (_context, move): readonly RuleEvidence[] => {
      if (
        configuration.dependsOnMoveSet === true ||
        configuration.permits(move, [move])
      ) {
        return [];
      }
      return [{
        ruleId: configuration.id,
        kind: "eliminated",
        message: configuration.rejection(move),
        move,
      }];
    },
  };
}
