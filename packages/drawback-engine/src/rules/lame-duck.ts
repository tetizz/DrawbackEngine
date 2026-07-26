import { defineMoveFilterRule } from "./common.js";

export const lameDuckRule = defineMoveFilterRule({
  id: "lame-duck",
  name: "Lame Duck",
  description: "The player cannot make a move whose primary mover is the king.",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  permits: (move) => move.piece !== "king",
  rejection: (move) => `${move.san} moves the king, which Lame Duck forbids.`,
});
