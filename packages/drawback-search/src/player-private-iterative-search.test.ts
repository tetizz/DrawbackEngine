import { describe, expect, it } from "vitest";
import {
  CapturableKingPosition,
  createPublicGameTrace,
} from "@drawbackengine/chess-core";
import {
  unrestrictedRule,
  type ChessMove,
  type PositionView,
} from "@drawbackengine/drawback-engine";
import { Mulberry32, type PlayerColor } from "@drawbackengine/shared";
import { drawbackMaterialEvaluator } from "./material-evaluator.js";
import {
  IncompletePlayerPrivateSearchError,
  searchIterativePlayerPrivateDrawbackMove,
} from "./player-private-iterative-search.js";
import {
  createOwnPlayerRuleCapability,
  createPublicDrawbackHypothesis,
} from "./player-private-capability.js";
import {
  searchPlayerPrivateDrawbackRootMove,
  type PlayerPrivateSearchInput,
} from "./player-private-search.js";
import { selectRootMoveByTemperature } from "./root-temperature-selector.js";

function context(position: CapturableKingPosition) {
  const trace = createPublicGameTrace(position.snapshot());
  const view: PositionView = {
    fen: position.fen,
    turn: position.turn,
    ply: 0,
    history: [],
  };
  return {
    trace,
    own: ownCapability(position.turn, position, view),
    opponent: [
      createPublicDrawbackHypothesis(
        "public-unrestricted-opponent",
        1,
        opposite(position.turn),
        unrestrictedRule,
        {},
        trace,
      ),
    ],
    aggregation: "worst-case" as const,
  };
}

function ownCapability(
  color: PlayerColor,
  position: CapturableKingPosition,
  view: PositionView,
) {
  return createOwnPlayerRuleCapability(
    "capturable-king/v1",
    color,
    unrestrictedRule,
    {},
    unrestrictedRule.initialize({
      color,
      parameters: {},
      position: view,
    }),
    view,
  );
}

describe("iterative player-private drawback search", () => {
  it("rejects an unknown cache-history mode at the public boundary", async () => {
    await expect(
      searchIterativePlayerPrivateDrawbackMove(
        context(CapturableKingPosition.fromFen()),
        drawbackMaterialEvaluator,
        {
          maxDepth: 1,
          maxNodes: 100,
          leafCacheHistoryMode: "ful" as never,
        },
      ),
    ).rejects.toThrow("leafCacheHistoryMode must be full or ignore");
  });

  it("returns deterministic complete root scores suitable for temperature selection", async () => {
    const position = CapturableKingPosition.fromFen();
    const input = context(position);
    const first = await searchIterativePlayerPrivateDrawbackMove(
      input,
      drawbackMaterialEvaluator,
      { maxDepth: 1, maxNodes: 5_000 },
    );
    const second = await searchIterativePlayerPrivateDrawbackMove(
      input,
      drawbackMaterialEvaluator,
      { maxDepth: 1, maxNodes: 5_000 },
    );

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      requestedDepth: 1,
      completedDepth: 1,
      stopReason: "target-depth",
      truncated: false,
      knowledgeMode: "player-private",
      aggregation: "worst-case",
      opponentHypothesisCount: 1,
    });
    expect(first.rootMoves).toHaveLength(position.legalMoves().length);
    expect(new Set(first.rootMoves.map((entry) => moveId(entry.move))).size)
      .toBe(first.rootMoves.length);
    expect(first.leafCache.hits + first.leafCache.misses).toBe(first.leaves);
    for (const entry of first.rootMoves) {
      expect(entry.principalVariation[0]).toEqual(entry.move);
    }
    const selection = selectRootMoveByTemperature(
      first.rootMoves,
      new Mulberry32(71),
      { temperatureCp: 35, topK: 3 },
    );
    expect(first.rootMoves.some(
      (entry) => moveId(entry.move) === moveId(selection.move),
    )).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(
      /parameters|internalState|secret|trueDrawback|public-unrestricted-opponent/u,
    );
  });

  it("discards a partial deeper iteration and rejects a partial first iteration", async () => {
    const input = context(CapturableKingPosition.fromFen());
    const completed = await searchIterativePlayerPrivateDrawbackMove(
      input,
      drawbackMaterialEvaluator,
      { maxDepth: 3, maxNodes: 60 },
    );

    expect(completed).toMatchObject({
      completedDepth: 1,
      stopReason: "node-budget",
      truncated: true,
      nodes: 60,
    });
    expect(completed.rootMoves).toHaveLength(20);

    await expect(
      searchIterativePlayerPrivateDrawbackMove(
        input,
        drawbackMaterialEvaluator,
        { maxDepth: 2, maxNodes: 5 },
      ),
    ).rejects.toBeInstanceOf(IncompletePlayerPrivateSearchError);
  });

  it("gives a terminal child priority at the exact node-budget boundary", async () => {
    const position = CapturableKingPosition.fromFen(
      "k7/8/8/8/8/8/4r3/4K2R w - - 0 1",
    );
    const root = position.legalMoves().find(
      (move) => move.from === "h1" && move.to === "h2",
    );
    if (root === undefined) {
      throw new Error("Expected h1-h2 to be authority-legal.");
    }
    let leafEvaluations = 0;
    const input: PlayerPrivateSearchInput = {
      ...context(position),
      evaluator: {
        id: "terminal-priority-test",
        evaluate() {
          leafEvaluations += 1;
          return Promise.resolve(0);
        },
      },
      limits: { depth: 2, maxNodes: 2 },
    };

    const result = await searchPlayerPrivateDrawbackRootMove(input, root);

    expect(result.score).toBeLessThan(-900_000);
    expect(result.principalVariation).toEqual([
      root,
      expect.objectContaining({
        from: "e2",
        to: "e1",
        captured: "king",
      }),
    ]);
    expect(result.knowledgeMode).toBe("player-private");
    expect(result.depth).toBe(2);
    expect(leafEvaluations).toBe(0);
  });

  it("rejects a requested root outside the exact own-rule legal mask", async () => {
    const position = CapturableKingPosition.fromFen();
    await expect(
      searchPlayerPrivateDrawbackRootMove(
        {
          ...context(position),
          evaluator: drawbackMaterialEvaluator,
          limits: { depth: 1, maxNodes: 100 },
        },
        { from: "e2", to: "e5" },
      ),
    ).rejects.toThrow("not legal under the player's drawback");
  });

  it("fails closed on a structurally forged own capability", async () => {
    const input = context(CapturableKingPosition.fromFen());

    await expect(
      searchIterativePlayerPrivateDrawbackMove(
        { ...input, own: { ...input.own } },
        drawbackMaterialEvaluator,
        { maxDepth: 1, maxNodes: 100 },
      ),
    ).rejects.toThrow("Own rule capability was not minted");
  });
});

function moveId(
  move: Pick<ChessMove, "from" | "to" | "promotion">,
): string {
  return `${move.from}${move.to}${move.promotion?.[0] ?? ""}`;
}

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}
