import {
  inspectPublicGameTrace,
  publicAuthorityLegalMoves,
  publicGameTraceView,
} from "@drawbackengine/chess-core";
import {
  drawbackMaterialEvaluator,
  type IterativePlayerPrivateSearchResult,
} from "@drawbackengine/drawback-search";
import { describe, expect, it, vi } from "vitest";
import {
  PlayerPrivatePlayGame,
  type PlayerPrivatePlaySearch,
  type PlayerPrivatePlaySearchRequest,
} from "./player-private-play.js";

describe("player-private human play facade", () => {
  it("projects a complete board and only the human's own drawback", () => {
    const game = PlayerPrivatePlayGame.create({
      seed: 11,
      humanColor: "white",
      humanDrawbackId: "vegan",
      engineDrawbackId: "checkers",
    });

    const observation = game.observation();
    expect(observation.board).toHaveLength(64);
    expect(observation.board.filter(({ occupant }) => occupant !== null))
      .toHaveLength(32);
    expect(observation.actions).toHaveLength(20);
    expect(observation.ownDrawback).toMatchObject({
      id: "vegan",
      name: "Vegan",
    });
    expect(JSON.stringify(observation)).not.toContain("checkers");
    expect(JSON.stringify(observation)).not.toMatch(
      /"(?:fen|san|captured|parameters|state|seed|opponent)"/iu,
    );
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.board)).toBe(true);
    expect(Object.isFrozen(observation.actions)).toBe(true);
    for (const action of observation.actions) {
      expect(action.actionId).toMatch(/^action_[A-Za-z\d_-]{24}$/u);
      expect(action.actionId).not.toBe(`${action.from}${action.to}`);
    }
    expect(() => game.reveal()).toThrow(
      "Drawbacks cannot be revealed before the game ends",
    );
  });

  it("expires action capabilities and preserves stateful drawback history", async () => {
    const search = scriptedSearch("e7", "e5");
    const game = PlayerPrivatePlayGame.create(
      {
        seed: 12,
        humanColor: "white",
        humanDrawbackId: "truant",
        engineDrawbackId: "checkers",
      },
      { search },
    );
    const opening = game.observation();
    const e2e4 = requiredAction(opening.actions, "e2", "e4");
    const stale = requiredAction(opening.actions, "d2", "d4");

    const accepted = game.submitHumanAction(e2e4.actionId);
    expect(accepted).toMatchObject({
      ok: true,
      move: { from: "e2", to: "e4" },
    });
    const rejectedStale = game.submitHumanAction(stale.actionId);
    expect(rejectedStale).toMatchObject({
      ok: false,
      message: "Action is no longer available.",
    });

    const engine = await game.playEngineTurn(
      drawbackMaterialEvaluator,
      { maxDepth: 1, maxNodes: 1_000 },
    );
    expect(engine).toMatchObject({
      move: { from: "e7", to: "e5" },
      knowledgeMode: "player-private",
    });
    expect(Object.keys(engine).sort()).toEqual([
      "evaluatorId",
      "knowledgeMode",
      "move",
      "observation",
    ]);
    expect(engine.observation.ply).toBe(2);
    expect(engine.observation.turn).toBe("white");
    expect(
      engine.observation.actions.some(
        ({ from, to }) => from === "e4" && to === "e5",
      ),
    ).toBe(false);
  });

  it("gives search only its own exact capability and public hypotheses", async () => {
    let inspected = false;
    const search: PlayerPrivatePlaySearch = (request) => {
      inspected = true;
      expect(Object.keys(request.context).sort()).toEqual([
        "aggregation",
        "opponent",
        "own",
        "trace",
      ]);
      expect(request.context.own).toMatchObject({
        capabilityKind: "own-player-rule",
        color: "white",
        drawbackId: "checkers",
      });
      expect(request.context.own).not.toHaveProperty("parameters");
      expect(request.context.own).not.toHaveProperty("state");
      expect(JSON.stringify(request.context.opponent)).not.toMatch(
        /parameters|internalState|secret|reveal|seed/iu,
      );
      return Promise.resolve(chooseFirstLegal(request));
    };
    const game = PlayerPrivatePlayGame.create(
      {
        seed: 13,
        humanColor: "black",
        humanDrawbackId: "vegan",
        engineDrawbackId: "checkers",
      },
      { search },
    );

    await game.playEngineTurn(
      drawbackMaterialEvaluator,
      { maxDepth: 1, maxNodes: 1_000 },
    );
    expect(inspected).toBe(true);
    expect(JSON.stringify(game.observation())).not.toContain("checkers");
  });

  it("discloses the affected player's Triple Play parameter without raw state", () => {
    const game = PlayerPrivatePlayGame.create({
      seed: 14,
      humanColor: "white",
      humanDrawbackId: "triple-play",
      engineDrawbackId: "vegan",
    });

    const observation = game.observation();
    expect(observation.ownDrawback.turnInstructions).toHaveLength(1);
    expect(observation.ownDrawback.turnInstructions[0]).toMatch(
      /^Required piece type: (bishop|knight)\.$/u,
    );
    expect(JSON.stringify(observation)).not.toMatch(/parameters|state|seed/iu);
  });

  it("sanitizes a king-capture ending and reveals both rules only afterward", () => {
    const game = PlayerPrivatePlayGame.create({
      seed: 15,
      humanColor: "white",
      humanDrawbackId: "vegan",
      engineDrawbackId: "checkers",
      initialFen: "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    });
    const action = requiredAction(game.observation().actions, "e7", "e8");
    const result = game.submitHumanAction(action.actionId);
    if (!result.ok) {
      throw new Error("Expected the projected king capture to be accepted.");
    }

    expect(result.observation.status).toEqual({
      kind: "win",
      winner: "white",
      reason: "king-capture",
    });
    expect(JSON.stringify(result.observation)).not.toContain("checkers");
    expect(game.reveal()).toMatchObject({
      white: { id: "vegan" },
      black: { id: "checkers" },
    });
  });

  it("does not apply a move when player-private search is cancelled", async () => {
    const started = vi.fn();
    const search: PlayerPrivatePlaySearch = async ({ limits }) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = (): void => {
          const reason: unknown = limits.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("cancelled"));
        };
        limits.signal?.addEventListener("abort", onAbort, { once: true });
      });
      throw new Error("unreachable");
    };
    const game = PlayerPrivatePlayGame.create(
      {
        seed: 16,
        humanColor: "black",
        humanDrawbackId: "vegan",
        engineDrawbackId: "checkers",
      },
      { search },
    );
    const controller = new AbortController();
    const pending = game.playEngineTurn(
      drawbackMaterialEvaluator,
      { maxDepth: 2, maxNodes: 10_000, signal: controller.signal },
    );
    await vi.waitFor(() => {
      expect(started).toHaveBeenCalledOnce();
    });
    const cancellation = new Error("test cancellation");
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(game.observation()).toMatchObject({ ply: 0, turn: "white" });
  });

  it("rejects a late engine result after resignation without changing the position", async () => {
    const started = vi.fn();
    let releaseSearch: (() => void) | undefined;
    const search: PlayerPrivatePlaySearch = async (request) => {
      started();
      await new Promise<void>((resolve) => {
        releaseSearch = resolve;
      });
      return chooseFirstLegal(request);
    };
    const game = PlayerPrivatePlayGame.create(
      {
        seed: 18,
        humanColor: "black",
        humanDrawbackId: "vegan",
        engineDrawbackId: "checkers",
      },
      { search },
    );
    const before = game.observation().board;
    const pending = game.playEngineTurn(
      drawbackMaterialEvaluator,
      { maxDepth: 2, maxNodes: 10_000 },
    );
    await vi.waitFor(() => {
      expect(started).toHaveBeenCalledOnce();
      expect(releaseSearch).toBeTypeOf("function");
    });

    const resigned = game.resignHuman();
    releaseSearch?.();

    await expect(pending).rejects.toThrow(
      "The game changed while the engine was thinking.",
    );
    expect(game.observation()).toMatchObject({
      ply: 0,
      turn: "white",
      status: { kind: "win", winner: "white", reason: "resignation" },
    });
    expect(game.observation().board).toEqual(before);
    expect(resigned.board).toEqual(before);
  });

  it("rejects a concurrent engine turn while allowing the original search to commit", async () => {
    const started = vi.fn();
    let releaseSearch: (() => void) | undefined;
    const search: PlayerPrivatePlaySearch = async (request) => {
      started();
      await new Promise<void>((resolve) => {
        releaseSearch = resolve;
      });
      return chooseFirstLegal(request, "e2", "e4");
    };
    const game = PlayerPrivatePlayGame.create(
      {
        seed: 19,
        humanColor: "black",
        humanDrawbackId: "vegan",
        engineDrawbackId: "checkers",
      },
      { search },
    );
    const first = game.playEngineTurn(
      drawbackMaterialEvaluator,
      { maxDepth: 2, maxNodes: 10_000 },
    );
    await vi.waitFor(() => {
      expect(started).toHaveBeenCalledOnce();
      expect(releaseSearch).toBeTypeOf("function");
    });

    await expect(game.playEngineTurn(
      drawbackMaterialEvaluator,
      { maxDepth: 2, maxNodes: 10_000 },
    )).rejects.toThrow("An engine turn is already in progress.");
    expect(started).toHaveBeenCalledOnce();

    releaseSearch?.();
    await expect(first).resolves.toMatchObject({
      move: { from: "e2", to: "e4" },
    });
    expect(game.observation()).toMatchObject({ ply: 1, turn: "black" });
    expect(started).toHaveBeenCalledOnce();
  });

  it("ends through a sanitized resignation without changing the board", () => {
    const game = PlayerPrivatePlayGame.create({
      seed: 17,
      humanColor: "white",
      humanDrawbackId: "vegan",
      engineDrawbackId: "checkers",
    });
    const before = game.observation().board;
    const after = game.resignHuman();

    expect(after.status).toEqual({
      kind: "win",
      winner: "black",
      reason: "resignation",
    });
    expect(after.actions).toEqual([]);
    expect(after.board).toEqual(before);
    expect(game.reveal().black.id).toBe("checkers");
  });
});

function requiredAction(
  actions: readonly {
    readonly actionId: string;
    readonly from: string;
    readonly to: string;
  }[],
  from: string,
  to: string,
) {
  const action = actions.find(
    (candidate) => candidate.from === from && candidate.to === to,
  );
  if (action === undefined) {
    throw new Error(`Expected projected action ${from}-${to}.`);
  }
  return action;
}

function scriptedSearch(from: string, to: string): PlayerPrivatePlaySearch {
  return (request) => Promise.resolve(chooseFirstLegal(request, from, to));
}

function chooseFirstLegal(
  request: PlayerPrivatePlaySearchRequest,
  preferredFrom?: string,
  preferredTo?: string,
): IterativePlayerPrivateSearchResult {
  const position = publicGameTraceView(request.context.trace);
  const authority = publicAuthorityLegalMoves(
    inspectPublicGameTrace(request.context.trace).current,
  );
  const legal = request.context.own.legalMoves(position, authority);
  const move = legal.find(
    (candidate) =>
      candidate.from === preferredFrom && candidate.to === preferredTo,
  ) ?? legal[0];
  if (move === undefined) {
    throw new Error("Expected at least one exact engine move.");
  }
  return Object.freeze({
    move,
    score: 0,
    principalVariation: Object.freeze([move]),
    nodes: 1,
    leaves: 0,
    truncated: false,
    rootColor: position.turn,
    evaluatorId: request.evaluator.id,
    knowledgeMode: "player-private",
    aggregation: request.context.aggregation,
    opponentHypothesisCount: request.context.opponent.length,
    requestedDepth: request.limits.maxDepth,
    completedDepth: request.limits.maxDepth,
    stopReason: "target-depth",
    rootMoves: Object.freeze([
      Object.freeze({
        move,
        score: 0,
        principalVariation: Object.freeze([move]),
      }),
    ]),
    leafCache: Object.freeze({
      hits: 0,
      misses: 0,
      evictions: 0,
      entries: 0,
      maxEntries: 1,
      historyMode: "full",
    }),
  });
}
