import type { DrawbackRule } from "../types.js";
import { isCapture, type NoParameters } from "./common.js";

export interface RemorsefulState {
  readonly previousMoveWasCapture: boolean;
}

export const remorsefulRule: DrawbackRule<RemorsefulState, NoParameters> = {
  id: "remorseful",
  name: "Remorseful",
  description: "The player cannot capture on two consecutive turns.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: () => ({ previousMoveWasCapture: false }),
  filterLegalMoves: (context, moves) =>
    context.state.previousMoveWasCapture
      ? moves.filter((move) => !isCapture(move))
      : [...moves],
  applyMove: (_context, move) => ({
    previousMoveWasCapture: isCapture(move),
  }),
  checkStartOfTurnLoss: () => null,
};
