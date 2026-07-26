import type { DrawbackRule, PieceType } from "../types.js";
import type { NoParameters } from "./common.js";

export interface SpiceOfLifeState {
  readonly previousMoverType: PieceType | null;
}

export const spiceOfLifeRule: DrawbackRule<SpiceOfLifeState, NoParameters> = {
  id: "spice-of-life",
  name: "Spice of Life",
  description: "The same primary piece type cannot move on consecutive turns.",
  verification: "implemented-unverified",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  generateParameters: () => ({}),
  initialize: () => ({ previousMoverType: null }),
  filterLegalMoves: (context, moves) =>
    context.state.previousMoverType === null
      ? [...moves]
      : moves.filter((move) => move.piece !== context.state.previousMoverType),
  applyMove: (_context, move) => ({ previousMoverType: move.piece }),
  checkStartOfTurnLoss: () => null,
  explainMove: (context, move) =>
    context.state.previousMoverType === move.piece
      ? [
          {
            ruleId: "spice-of-life",
            kind: "eliminated",
            message: `${move.san} repeats the previous primary mover type (${move.piece}).`,
            move,
          },
        ]
      : [],
};
