import type { DrawbackRule } from "../types.js";
import type { NoParameters } from "./common.js";

export interface QuitHorsingAroundState {
  readonly previousMoveWasKnight: boolean;
}

export const quitHorsingAroundRule: DrawbackRule<
  QuitHorsingAroundState,
  NoParameters
> = {
  id: "quit-horsing-around",
  name: "Quit Horsing Around",
  description: "After moving a knight, the next move cannot be made by any knight.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: () => ({ previousMoveWasKnight: false }),
  filterLegalMoves: (context, moves) =>
    context.state.previousMoveWasKnight
      ? moves.filter((move) => move.piece !== "knight")
      : [...moves],
  applyMove: (_context, move) => ({
    previousMoveWasKnight: move.piece === "knight",
  }),
  checkStartOfTurnLoss: () => null,
};
