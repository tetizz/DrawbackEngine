import type { DrawbackRule } from "../types.js";
import {
  isCapture,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

export const checkersRule: DrawbackRule<StatelessRuleState, NoParameters> = {
  id: "checkers",
  name: "Checkers",
  description: "If at least one ordinary legal capture exists, the player must capture.",
  verification: "implemented-unverified",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  generateParameters: () => ({}),
  initialize: () => ({ movesApplied: 0 }),
  filterLegalMoves: (_context, moves) => {
    const captures = moves.filter(isCapture);
    return captures.length === 0 ? [...moves] : captures;
  },
  applyMove: (context) => ({ movesApplied: context.state.movesApplied + 1 }),
  checkStartOfTurnLoss: () => null,
};
