import { defineRerandomizedForbiddenMoverType } from "./parameterized-factories.js";

export const gamblerRule = defineRerandomizedForbiddenMoverType({
  id: "gambler",
  name: "Gambler",
  description:
    "One hidden piece type is forbidden from moving, deterministically re-randomized each turn.",
});
