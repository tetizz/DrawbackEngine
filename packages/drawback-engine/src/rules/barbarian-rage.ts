import type { DrawbackRule } from "../types.js";
import { isCapture, type NoParameters } from "./common.js";

export interface BarbarianRageState {
  readonly previousMoveWasCapture: boolean;
}

export const barbarianRageRule: DrawbackRule<BarbarianRageState, NoParameters> = {
  id: "barbarian-rage",
  name: "Barbarian Rage",
  description: "After capturing, the player must capture again on the next turn if able.",
  verification: "implemented-unverified",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  generateParameters: () => ({}),
  initialize: () => ({ previousMoveWasCapture: false }),
  filterLegalMoves: (context, moves) => {
    if (!context.state.previousMoveWasCapture) {
      return [...moves];
    }
    const captures = moves.filter(isCapture);
    return captures.length === 0 ? [...moves] : captures;
  },
  applyMove: (_context, move) => ({
    previousMoveWasCapture: isCapture(move),
  }),
  checkStartOfTurnLoss: () => null,
};
