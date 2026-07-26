import { defineMoveFilterRule, isCapture } from "./common.js";

export const conscientiousObjectorsRule = defineMoveFilterRule({
  id: "conscientious-objectors",
  name: "Conscientious Objectors",
  description: "The player's pawns cannot capture.",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  permits: (move) => move.piece !== "pawn" || !isCapture(move),
  rejection: (move) =>
    `${move.san} is a pawn capture, which Conscientious Objectors forbids.`,
});
