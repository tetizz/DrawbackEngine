import type { DrawbackRule } from "../types.js";
import type {
  NoParameters,
  StatelessRuleState,
} from "./common.js";

const EXPEDITION_TURN_INDEX = 14;
const EXPEDITION_DESTINATION = "f1";

export const expeditionRule: DrawbackRule<
  StatelessRuleState,
  NoParameters
> = {
  id: "expedition",
  name: "Expedition",
  description:
    "On the affected player's fifteenth turn, the primary move must end on f1.",
  verification: "implemented-unverified",
  generateParameters: () => ({}),
  initialize: (context) => ({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
  }),
  filterLegalMoves: (context, moves) =>
    context.state.movesApplied === EXPEDITION_TURN_INDEX
      ? moves.filter((move) => move.to === EXPEDITION_DESTINATION)
      : [...moves],
  applyMove: (context) => ({
    movesApplied: context.state.movesApplied + 1,
  }),
  checkStartOfTurnLoss: () => null,
  describeTurn: (context) =>
    context.state.movesApplied === EXPEDITION_TURN_INDEX
      ? ["Expedition: this move must end on f1."]
      : [],
};
