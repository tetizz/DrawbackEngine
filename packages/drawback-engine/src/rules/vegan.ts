import { defineMoveFilterRule } from "./common.js";

export const veganRule = defineMoveFilterRule({
  id: "vegan",
  name: "Vegan",
  description: "The player cannot capture an opposing knight.",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  permits: (move) => move.captured !== "knight",
  rejection: (move) => `${move.san} captures a knight, which Vegan forbids.`,
});
