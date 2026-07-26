import { defineMoveFilterRule, isCapture } from "./common.js";

export const falseProphetsRule = defineMoveFilterRule({
  id: "false-prophets",
  name: "False Prophets",
  description: "Bishops cannot capture.",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  permits: (move) => move.piece !== "bishop" || !isCapture(move),
  rejection: (move) => `${move.san} captures with a bishop.`,
});
