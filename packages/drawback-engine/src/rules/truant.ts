import type { DrawbackRule } from "../types.js";
import type { NoParameters } from "./common.js";

export interface TruantState {
  readonly previousMoverDestination: string | null;
}

export const truantRule: DrawbackRule<TruantState, NoParameters> = {
  id: "truant",
  name: "Truant",
  description: "The same physical primary piece cannot move on consecutive turns.",
  verification: "implemented-unverified",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  generateParameters: () => ({}),
  initialize: () => ({ previousMoverDestination: null }),
  filterLegalMoves: (context, moves) =>
    context.state.previousMoverDestination === null
      ? [...moves]
      : moves.filter((move) => move.from !== context.state.previousMoverDestination),
  applyMove: (_context, move) => ({ previousMoverDestination: move.to }),
  checkStartOfTurnLoss: () => null,
  explainMove: (context, move) =>
    context.state.previousMoverDestination === move.from
      ? [
          {
            ruleId: "truant",
            kind: "eliminated",
            message: `${move.san} moves the same primary piece as the previous turn.`,
            move,
          },
        ]
      : [],
};
