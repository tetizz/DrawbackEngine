import { defineMoveFilterRule } from "./common.js";

export const cessRule = defineMoveFilterRule({
  id: "cess",
  name: "Cess",
  description: "The player cannot move a primary piece to the h-file.",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  permits: (move) => !move.to.startsWith("h"),
  rejection: (move) =>
    `${move.san} ends on the h-file, which Cess forbids.`,
});
