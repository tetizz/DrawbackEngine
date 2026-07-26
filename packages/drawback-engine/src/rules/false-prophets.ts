import { defineMoveFilterRule, isCapture } from "./common.js";

export const falseProphetsRule = defineMoveFilterRule({
  id: "false-prophets",
  name: "False Prophets",
  description: "Bishops cannot capture.",
  permits: (move) => move.piece !== "bishop" || !isCapture(move),
  rejection: (move) => `${move.san} captures with a bishop.`,
});
