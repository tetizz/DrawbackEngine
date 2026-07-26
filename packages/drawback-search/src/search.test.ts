import { describe, expect, it } from "vitest";
import { DrawbackGameSession } from "@drawbackengine/chess-core";
import type {
  DrawbackLoss,
  DrawbackRule,
} from "@drawbackengine/drawback-engine";
import { unrestrictedRule } from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { drawbackMaterialEvaluator } from "./material-evaluator.js";
import {
  searchOmniscientDrawbackMove,
  searchOmniscientDrawbackRootMove,
} from "./search.js";

interface DelayedLossState {
  readonly armed: boolean;
}

const delayedLossRule: DrawbackRule<
  DelayedLossState,
  Record<string, never>
> = {
  id: "test-delayed-loss",
  name: "Delayed loss",
  description: "Moving to h3 causes a loss at the next affected turn.",
  verification: "verified",
  supportedAuthorities: ["capturable-king/v1"],
  generateParameters: () => ({}),
  initialize: () => ({ armed: false }),
  filterLegalMoves: (_context, moves) => [...moves],
  applyMove: (context, move) => ({
    armed: context.state.armed || move.to === "h3",
  }),
  checkStartOfTurnLoss: (context): DrawbackLoss | null =>
    context.state.armed
      ? {
          ruleId: "test-delayed-loss",
          color: context.color,
          reason: "The test deadline expired.",
        }
      : null,
};

describe("searchOmniscientDrawbackMove", () => {
  it("treats literal king capture as the decisive terminal move", async () => {
    const session = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(1),
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    );
    const result = await searchOmniscientDrawbackMove(
      session,
      drawbackMaterialEvaluator,
      { depth: 2, maxNodes: 2_000 },
    );
    expect(result.move).toMatchObject({
      from: "e7",
      to: "e8",
      captured: "king",
    });
    expect(result.score).toBeGreaterThan(900_000);
    expect(result.knowledgeMode).toBe("omniscient-oracle");
  });

  it("searches future rule state and avoids a tempting delayed drawback loss", async () => {
    const session = DrawbackGameSession.create(
      { white: delayedLossRule, black: unrestrictedRule },
      new Mulberry32(2),
      "k7/8/8/8/8/7q/8/K6R w - - 0 1",
    );
    const captureQueen = session
      .legalMoves()
      .find((move) => move.from === "h1" && move.to === "h3");
    expect(captureQueen?.captured).toBe("queen");

    const result = await searchOmniscientDrawbackMove(
      session,
      drawbackMaterialEvaluator,
      { depth: 2, maxNodes: 5_000 },
    );
    expect(result.move).not.toMatchObject({ from: "h1", to: "h3" });
    expect(session.history()).toHaveLength(0);
    expect(session.result).toEqual({ kind: "active" });
  });

  it("is deterministic and leaves the searched session untouched", async () => {
    const session = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(3),
    );
    const first = await searchOmniscientDrawbackMove(
      session,
      drawbackMaterialEvaluator,
      { depth: 2, maxNodes: 2_000 },
    );
    const second = await searchOmniscientDrawbackMove(
      session,
      drawbackMaterialEvaluator,
      { depth: 2, maxNodes: 2_000 },
    );
    expect(second).toEqual(first);
    expect(session.history()).toHaveLength(0);
    expect(session.turn).toBe("white");
  });

  it("reports deterministic truncation at a fixed node budget", async () => {
    const session = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(4),
    );
    const result = await searchOmniscientDrawbackMove(
      session,
      drawbackMaterialEvaluator,
      { depth: 4, maxNodes: 30 },
    );
    expect(result.truncated).toBe(true);
    expect(result.nodes).toBe(30);
    expect(session.legalMoves()).toContainEqual(result.move);
  });

  it("scores a terminal child reached exactly at the node budget", async () => {
    const session = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(41),
      "k7/8/8/8/8/8/4r3/4K2R w - - 0 1",
    );
    const root = session.legalMoves().find(
      (move) => move.from === "h1" && move.to === "h2",
    );
    if (root === undefined) {
      throw new Error("Expected h1-h2 to be legal.");
    }
    let leafEvaluations = 0;

    const result = await searchOmniscientDrawbackRootMove(
      session,
      root,
      {
        id: "terminal-boundary-test",
        evaluate() {
          leafEvaluations += 1;
          return Promise.resolve(0);
        },
      },
      { depth: 2, maxNodes: 2 },
    );

    expect(result.score).toBeLessThan(-900_000);
    expect(result.principalVariation).toEqual([
      root,
      expect.objectContaining({
        from: "e2",
        to: "e1",
        captured: "king",
      }),
    ]);
    expect(result.truncated).toBe(true);
    expect(result.nodes).toBe(2);
    expect(leafEvaluations).toBe(0);
  });

  it("honors cancellation before search begins", async () => {
    const session = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(5),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchOmniscientDrawbackMove(session, drawbackMaterialEvaluator, {
        depth: 2,
        maxNodes: 100,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("scores one legal root with a complete full-window line", async () => {
    const session = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(6),
    );
    const root = session.legalMoves().find(
      (move) => move.from === "e2" && move.to === "e4",
    );
    if (root === undefined) {
      throw new Error("Expected e2-e4 to be legal.");
    }

    const result = await searchOmniscientDrawbackRootMove(
      session,
      root,
      drawbackMaterialEvaluator,
      { depth: 2, maxNodes: 2_000 },
    );

    expect(result).toMatchObject({
      move: root,
      depth: 2,
      truncated: false,
      knowledgeMode: "omniscient-oracle",
    });
    expect(result.principalVariation[0]).toEqual(root);
    expect(session.history()).toEqual([]);
  });

  it("rejects a root outside the exact drawback move set", async () => {
    await expect(
      searchOmniscientDrawbackRootMove(
        DrawbackGameSession.create(
          { white: unrestrictedRule, black: unrestrictedRule },
          new Mulberry32(7),
        ),
        { from: "e2", to: "e5" },
        drawbackMaterialEvaluator,
        { depth: 1, maxNodes: 100 },
      ),
    ).rejects.toThrow("is not drawback-legal");
  });
});
