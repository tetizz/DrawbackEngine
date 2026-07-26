import { defineMoveFilterRule, isCapture } from "./common.js";

export const horseTranquilizerRule = defineMoveFilterRule({
  id: "horse-tranquilizer",
  name: "Horse Tranquilizer",
  description: "The player's knights cannot capture.",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  permits: (move) => move.piece !== "knight" || !isCapture(move),
  rejection: (move) =>
    `${move.san} is a knight capture, which Horse Tranquilizer forbids.`,
});
