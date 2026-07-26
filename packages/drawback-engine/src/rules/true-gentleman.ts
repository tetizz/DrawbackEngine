import { defineMoveFilterRule } from "./common.js";

export const trueGentlemanRule = defineMoveFilterRule({
  id: "true-gentleman",
  name: "True Gentleman",
  description: "The player cannot capture an opposing queen.",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  permits: (move) => move.captured !== "queen",
  rejection: (move) =>
    `${move.san} captures a queen, which True Gentleman forbids.`,
});
