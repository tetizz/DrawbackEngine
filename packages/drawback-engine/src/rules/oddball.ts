import type { DrawbackRule } from "../types.js";
import {
  isCapture,
  type NoParameters,
  type StatelessRuleState,
} from "./common.js";

export type MoveNumberParity = "odd" | "even";

function fullmoveNumber(fen: string): number {
  const field = fen.trim().split(/\s+/)[5];
  if (field === undefined || !/^[1-9]\d*$/.test(field)) {
    throw new RangeError(`Position FEN has no valid fullmove number: ${fen}.`);
  }
  return Number(field);
}

export function defineCaptureParityRule(configuration: {
  readonly id: string;
  readonly name: string;
  readonly parity: MoveNumberParity;
}): DrawbackRule<StatelessRuleState, NoParameters> {
  return {
    id: configuration.id,
    name: configuration.name,
    description: `The player can capture only on ${configuration.parity}-numbered fullmoves.`,
    verification: "implemented-unverified",
    generateParameters: () => ({}),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (context, moves) => {
      const isEven = fullmoveNumber(context.position.fen) % 2 === 0;
      const captureAllowed =
        configuration.parity === "even" ? isEven : !isEven;
      return captureAllowed ? [...moves] : moves.filter((move) => !isCapture(move));
    },
    applyMove: (context) => ({ movesApplied: context.state.movesApplied + 1 }),
    checkStartOfTurnLoss: () => null,
  };
}

export const oddballRule = defineCaptureParityRule({
  id: "oddball",
  name: "Oddball",
  parity: "odd",
});
