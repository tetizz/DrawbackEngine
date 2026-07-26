import { defineMoveFilterRule, isCapture } from "./common.js";

export const trophyWifeRule = defineMoveFilterRule({
  id: "trophy-wife",
  name: "Trophy Wife",
  description: "The player's queen cannot capture.",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  permits: (move) => move.piece !== "queen" || !isCapture(move),
  rejection: (move) =>
    `${move.san} is a capture by the queen, which Trophy Wife forbids.`,
});
