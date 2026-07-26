import { defineMoveFilterRule, isCapture } from "./common.js";

export const conscientiousObjectorsRule = defineMoveFilterRule({
  id: "conscientious-objectors",
  name: "Conscientious Objectors",
  description: "The player's pawns cannot capture.",
  permits: (move) => move.piece !== "pawn" || !isCapture(move),
  rejection: (move) =>
    `${move.san} is a pawn capture, which Conscientious Objectors forbids.`,
});
