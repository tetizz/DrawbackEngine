import { defineMoveFilterRule } from "./common.js";

function rank(square: string): number {
  const value = Number(square[1]);
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new RangeError(`Invalid chess square: ${square}.`);
  }
  return value;
}

export const forwardMarchRule = defineMoveFilterRule({
  id: "forward-march",
  name: "Forward March",
  description: "The player cannot move a primary piece toward its home rank.",
  supportedAuthorities: ["standard-chess/v1", "capturable-king/v1"],
  permits: (move) => {
    const progress = rank(move.to) - rank(move.from);
    return move.color === "white" ? progress >= 0 : progress <= 0;
  },
  rejection: (move) =>
    `${move.san} moves backwards from ${move.color}'s perspective.`,
});
