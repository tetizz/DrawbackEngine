import type {
  ChessMove,
  DrawbackRule,
} from "../types.js";
import {
  squareCoordinates,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

const RIVER_RANKS = new Set([4, 5]);
const BRIDGE_FILES = new Set([4, 5]);

function isWater(square: string): boolean {
  const { file, rank } = squareCoordinates(square);
  return RIVER_RANKS.has(rank) && !BRIDGE_FILES.has(file);
}

function oppositeBanks(move: Pick<ChessMove, "from" | "to">): boolean {
  const fromRank = squareCoordinates(move.from).rank;
  const toRank = squareCoordinates(move.to).rank;
  return (
    (fromRank <= 3 && toRank >= 6) ||
    (fromRank >= 6 && toRank <= 3)
  );
}

function traversedRiverSquares(
  move: Pick<ChessMove, "from" | "to">,
): readonly string[] {
  const from = squareCoordinates(move.from);
  const to = squareCoordinates(move.to);
  const fileDelta = to.file - from.file;
  const rankDelta = to.rank - from.rank;
  const distance = Math.max(Math.abs(fileDelta), Math.abs(rankDelta));
  const isLine =
    fileDelta === 0 ||
    rankDelta === 0 ||
    Math.abs(fileDelta) === Math.abs(rankDelta);
  if (!isLine || distance === 0) {
    return [];
  }
  const fileStep = Math.sign(fileDelta);
  const rankStep = Math.sign(rankDelta);
  const squares: string[] = [];
  for (let step = 1; step <= distance; step += 1) {
    const file = from.file + fileStep * step;
    const rank = from.rank + rankStep * step;
    if (RIVER_RANKS.has(rank)) {
      squares.push(`${String.fromCharCode(96 + file)}${String(rank)}`);
    }
  }
  return squares;
}

export function bridgePermitsMove(
  move: Pick<ChessMove, "from" | "to">,
): boolean {
  if (isWater(move.to)) {
    return false;
  }
  if (!oppositeBanks(move)) {
    return true;
  }
  const riverSquares = traversedRiverSquares(move);
  return (
    riverSquares.length > 0 &&
    riverSquares.every(
      (square) => BRIDGE_FILES.has(squareCoordinates(square).file),
    )
  );
}

export const bridgeOverTroubledWaterRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "bridge-over-troubled-water",
  name: "Bridge Over Troubled Water",
  description:
    "The middle two ranks are a river: primary movers cannot land in its water and line moves may cross between banks only through the d/e-file bridge.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
  }),
  filterLegalMoves: (_context, moves) =>
    moves.filter((move) => bridgePermitsMove(move)),
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
};
