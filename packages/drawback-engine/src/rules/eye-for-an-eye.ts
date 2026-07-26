import type { DrawbackRule, RuleMoveContext } from "../types.js";
import { isCapture, type NoParameters } from "./common.js";

export interface EyeForAnEyeState {
  readonly movesApplied: number;
}

function opponentLastMovedWithCapture(
  context: RuleMoveContext<EyeForAnEyeState, NoParameters>,
): boolean {
  const lastMove = context.position.history.at(-1);
  return (
    lastMove !== undefined &&
    lastMove.color !== context.color &&
    isCapture(lastMove)
  );
}

export const eyeForAnEyeRule: DrawbackRule<EyeForAnEyeState, NoParameters> = {
  id: "eye-for-an-eye",
  name: "Eye for an Eye",
  description: "If the opponent captured, the player must capture next or lose.",
  verification: "implemented-unverified",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  generateParameters: () => ({}),
  initialize: () => ({ movesApplied: 0 }),
  filterLegalMoves: (context, moves) =>
    opponentLastMovedWithCapture(context) ? moves.filter(isCapture) : [...moves],
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  // GameSession evaluates the filtered zero-move set immediately after this
  // hook, producing the sourced start-of-turn drawback loss exactly when no
  // ordinary legal capture can satisfy the obligation.
  checkStartOfTurnLoss: () => null,
};
