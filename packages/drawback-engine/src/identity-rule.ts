import type { DrawbackRule } from "./types.js";

export interface EmptyRuleState {
  readonly movesApplied: number;
}

export type EmptyRuleParameters = Record<string, never>;

export const unrestrictedRule: DrawbackRule<EmptyRuleState, EmptyRuleParameters> = {
  id: "unrestricted",
  name: "Unrestricted",
  description: "No additional restriction. Test and control rule only.",
  verification: "verified",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  generateParameters: () => ({}),
  initialize: () => ({
    movesApplied: 0,
  }),
  filterLegalMoves: (context, moves) => {
    void context;
    return [...moves];
  },
  applyMove: (context) => ({ movesApplied: context.state.movesApplied + 1 }),
  checkStartOfTurnLoss: () => null,
};
