import type { DrawbackRule } from "../types.js";
import type { NoParameters, StatelessRuleState } from "./common.js";

function capturesPawn(move: { readonly captured?: string }): boolean {
  return move.captured === "pawn";
}

export const pacmanRule: DrawbackRule<StatelessRuleState, NoParameters> = {
  id: "pacman",
  name: "Pacman",
  description: "If an ordinary legal pawn capture exists, the player must make one.",
  verification: "implemented-unverified",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  generateParameters: () => ({}),
  initialize: () => ({ movesApplied: 0 }),
  filterLegalMoves: (_context, moves) => {
    const pawnCaptures = moves.filter(capturesPawn);
    return pawnCaptures.length === 0 ? [...moves] : pawnCaptures;
  },
  applyMove: (context) => ({ movesApplied: context.state.movesApplied + 1 }),
  checkStartOfTurnLoss: () => null,
};
