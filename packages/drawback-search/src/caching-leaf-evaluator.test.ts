import { describe, expect, it, vi } from "vitest";
import type {
  DrawbackLeafEvaluator,
  LeafPosition,
} from "./types.js";
import { createCachingLeafEvaluator } from "./caching-leaf-evaluator.js";

const BASE_MOVE = {
  from: "e1",
  to: "e2",
  color: "white",
  piece: "king",
  san: "Ke2",
  flags: "quiet",
} as const;

const BASE_POSITION: LeafPosition = {
  authorityId: "capturable-king/v1",
  fen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
  turn: "white",
  legalMoves: [BASE_MOVE],
  history: [],
  orthodoxCompatible: true,
  kingPassantActive: false,
};

function evaluator(score = 17): {
  readonly evaluator: DrawbackLeafEvaluator;
  readonly evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(() => Promise.resolve(score));
  return {
    evaluator: { id: "counting", evaluate },
    evaluate,
  };
}

describe("createCachingLeafEvaluator", () => {
  it("reuses a resolved evaluation for the complete identical leaf", async () => {
    const base = evaluator();
    const cached = createCachingLeafEvaluator({
      evaluator: base.evaluator,
      maxEntries: 4,
    });

    await expect(cached.evaluate(BASE_POSITION)).resolves.toBe(17);
    await expect(cached.evaluate(structuredClone(BASE_POSITION))).resolves.toBe(17);

    expect(base.evaluate).toHaveBeenCalledTimes(1);
    expect(cached.metrics()).toEqual({
      hits: 1,
      misses: 1,
      entries: 1,
      evictions: 0,
    });
  });

  it("separates legal masks, history, and non-FEN variant state", async () => {
    const base = evaluator();
    const cached = createCachingLeafEvaluator({
      evaluator: base.evaluator,
      maxEntries: 8,
    });
    const historyMove = {
      from: "e1",
      to: "e2",
      color: "white",
      piece: "king",
      san: "Ke2",
      flags: "quiet",
    } as const;

    await cached.evaluate(BASE_POSITION);
    await cached.evaluate({
      ...BASE_POSITION,
      legalMoves: [{
        ...BASE_MOVE,
        to: "f2",
        san: "Kf2",
      }],
    });
    await cached.evaluate({
      ...BASE_POSITION,
      history: [historyMove],
    });
    await cached.evaluate({
      ...BASE_POSITION,
      kingPassantActive: true,
    });

    expect(base.evaluate).toHaveBeenCalledTimes(4);
    expect(cached.metrics()).toMatchObject({ hits: 0, misses: 4, entries: 4 });
  });

  it("can explicitly share history-independent engine evaluations", async () => {
    const base = evaluator();
    const cached = createCachingLeafEvaluator({
      evaluator: base.evaluator,
      maxEntries: 4,
      historyMode: "ignore",
    });
    const withPublicHistory: LeafPosition = {
      ...BASE_POSITION,
      history: [{
        from: "a2",
        to: "a3",
        color: "white",
        piece: "pawn",
        san: "a3",
        flags: "quiet",
      }],
    };

    await cached.evaluate(BASE_POSITION);
    await cached.evaluate(withPublicHistory);

    expect(base.evaluate).toHaveBeenCalledTimes(1);
    expect(cached.metrics()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("does not cache failed or aborted evaluations", async () => {
    const evaluate = vi
      .fn<DrawbackLeafEvaluator["evaluate"]>()
      .mockRejectedValueOnce(new Error("engine failed"))
      .mockResolvedValueOnce(9);
    const cached = createCachingLeafEvaluator({
      evaluator: { id: "flaky", evaluate },
      maxEntries: 2,
    });

    await expect(cached.evaluate(BASE_POSITION)).rejects.toThrow("engine failed");
    await expect(cached.evaluate(BASE_POSITION)).resolves.toBe(9);
    expect(evaluate).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    controller.abort();
    await expect(
      cached.evaluate(BASE_POSITION, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used resolved entry", async () => {
    const base = evaluator();
    const cached = createCachingLeafEvaluator({
      evaluator: base.evaluator,
      maxEntries: 1,
    });
    const second = {
      ...BASE_POSITION,
      fen: "4k3/8/8/8/8/8/4K3/8 b - - 1 1",
      turn: "black",
      legalMoves: [{
        from: "e8",
        to: "e7",
        color: "black",
        piece: "king",
        san: "Ke7",
        flags: "quiet",
      }],
    } as const satisfies LeafPosition;

    await cached.evaluate(BASE_POSITION);
    await cached.evaluate(second);
    await cached.evaluate(BASE_POSITION);

    expect(base.evaluate).toHaveBeenCalledTimes(3);
    expect(cached.metrics()).toEqual({
      hits: 0,
      misses: 3,
      entries: 1,
      evictions: 2,
    });
  });

  it("validates capacity and wrapped evaluator identity", () => {
    const base = evaluator();
    expect(() =>
      createCachingLeafEvaluator({
        evaluator: base.evaluator,
        maxEntries: 0,
      })
    ).toThrow("positive safe integer");
    expect(() =>
      createCachingLeafEvaluator({
        evaluator: { id: " ", evaluate: base.evaluate },
        maxEntries: 1,
      })
    ).toThrow("must not be empty");
  });
});
