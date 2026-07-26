import { defineHiddenSquareRestriction } from "./parameterized-factories.js";

export const untitledDuckDrawbackRule = defineHiddenSquareRestriction({
  id: "untitled-duck-drawback",
  name: "Untitled Duck Drawback",
  description:
    "A duck occupies a hidden square; the player's primary mover cannot pass through or land on it.",
});
