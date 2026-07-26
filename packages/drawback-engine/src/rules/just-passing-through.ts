import { defineHiddenCaptureRankRestriction } from "./parameterized-factories.js";

export const justPassingThroughRule = defineHiddenCaptureRankRestriction({
  id: "just-passing-through",
  name: "Just Passing Through",
  description: "The player cannot capture on one hidden rank.",
});
