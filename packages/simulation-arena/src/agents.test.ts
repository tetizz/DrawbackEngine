import { describe, expect, it } from "vitest";
import { Mulberry32 } from "@drawbackengine/shared";
import type { AgentView } from "./simulation.js";
import {
  createTemperatureAgent,
  greedyMaterialAgent,
  strongHumanLikeAgent,
} from "./agents.js";

const view: AgentView = {
  color: "white",
  fen: "test-public-fen",
  ply: 0,
  history: [],
  legalMoves: [
    { from: "a2", to: "a3", color: "white", piece: "pawn", san: "a3", flags: "n" },
    { from: "d1", to: "d8", color: "white", piece: "queen", captured: "rook", san: "Qxd8+", flags: "c" },
  ],
};

describe("simulation agents", () => {
  it("greedily selects the highest-value capture", () => {
    expect(greedyMaterialAgent.chooseMove(view, new Mulberry32(1)).san).toBe("Qxd8+");
  });

  it("temperature agents are deterministic under a fixed seed", () => {
    const firstRng = new Mulberry32(99);
    const first = Array.from({ length: 12 }, () =>
      strongHumanLikeAgent.chooseMove(view, firstRng).san,
    );
    const secondRng = new Mulberry32(99);
    const second = Array.from({ length: 12 }, () =>
      strongHumanLikeAgent.chooseMove(view, secondRng).san,
    );
    expect(first).toEqual(second);
  });

  it("validates temperature", () => {
    expect(() => createTemperatureAgent({ id: "invalid", temperature: 0 })).toThrow(
      RangeError,
    );
  });

  it("agent views remain free of true-rule fields", () => {
    expect(view).not.toHaveProperty("drawback");
    expect(view).not.toHaveProperty("parameters");
    expect(view).not.toHaveProperty("trueRule");
  });
});
