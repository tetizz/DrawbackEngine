import { defineMoveFilterRule, isCapture } from "./common.js";

export const horseTranquilizerRule = defineMoveFilterRule({
  id: "horse-tranquilizer",
  name: "Horse Tranquilizer",
  description: "The player's knights cannot capture.",
  permits: (move) => move.piece !== "knight" || !isCapture(move),
  rejection: (move) =>
    `${move.san} is a knight capture, which Horse Tranquilizer forbids.`,
});
