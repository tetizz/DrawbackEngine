import { describe, expect, it } from "vitest";
import { DrawbackGameSession } from "@drawbackengine/chess-core";
import { unrestrictedRule } from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { drawbackMaterialEvaluator } from "./material-evaluator.js";
import {
  IncompleteDrawbackSearchError,
  searchIterativeOmniscientDrawbackMove,
} from "./iterative-search.js";
import { searchOmniscientDrawbackMove } from "./search.js";

function session() {
  return DrawbackGameSession.create(
    { white: unrestrictedRule, black: unrestrictedRule },
    new Mulberry32(11),
  );
}

describe("searchIterativeOmniscientDrawbackMove", () => {
  it("returns the requested fully completed depth", async () => {
    const game = session();
    const result = await searchIterativeOmniscientDrawbackMove(
      game,
      drawbackMaterialEvaluator,
      { maxDepth: 2, maxNodes: 5_000 },
    );

    expect(result).toMatchObject({
      requestedDepth: 2,
      completedDepth: 2,
      stopReason: "target-depth",
      truncated: false,
      knowledgeMode: "omniscient-oracle",
    });
    expect(game.legalMoves()).toContainEqual(result.move);
    expect(game.history()).toEqual([]);
  });

  it("discards a partial deeper iteration", async () => {
    const game = session();
    const depthOne = await searchOmniscientDrawbackMove(
      game,
      drawbackMaterialEvaluator,
      { depth: 1, maxNodes: 5_000 },
    );
    const result = await searchIterativeOmniscientDrawbackMove(
      game,
      drawbackMaterialEvaluator,
      { maxDepth: 4, maxNodes: 60 },
    );

    expect(result).toMatchObject({
      move: depthOne.move,
      score: depthOne.score,
      completedDepth: 1,
      stopReason: "node-budget",
      truncated: true,
      nodes: 60,
    });
  });

  it("fails rather than returning a partially searched root", async () => {
    await expect(
      searchIterativeOmniscientDrawbackMove(
        session(),
        drawbackMaterialEvaluator,
        { maxDepth: 3, maxNodes: 5 },
      ),
    ).rejects.toBeInstanceOf(IncompleteDrawbackSearchError);
  });

  it("is deterministic and reports cache accounting", async () => {
    const first = await searchIterativeOmniscientDrawbackMove(
      session(),
      drawbackMaterialEvaluator,
      { maxDepth: 2, maxNodes: 5_000 },
    );
    const second = await searchIterativeOmniscientDrawbackMove(
      session(),
      drawbackMaterialEvaluator,
      { maxDepth: 2, maxNodes: 5_000 },
    );

    expect(second).toEqual(first);
    expect(first.leafCache.misses).toBeGreaterThan(0);
    expect(first.leafCache.hits + first.leafCache.misses).toBe(first.leaves);
  });

  it("honors cancellation and validates limits", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchIterativeOmniscientDrawbackMove(
        session(),
        drawbackMaterialEvaluator,
        { maxDepth: 2, maxNodes: 100, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      searchIterativeOmniscientDrawbackMove(
        session(),
        drawbackMaterialEvaluator,
        { maxDepth: 0, maxNodes: 100 },
      ),
    ).rejects.toThrow("positive safe integer");
  });
});
