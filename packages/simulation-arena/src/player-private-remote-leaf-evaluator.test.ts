import type { LeafPosition } from "@drawbackengine/drawback-search";
import { describe, expect, it } from "vitest";
import {
  restorePlayerPrivateUciLeafPosition,
  snapshotPlayerPrivateUciLeafPosition,
  type PlayerPrivateWorkerEvaluationResult,
} from "./player-private-leaf-evaluator-protocol.js";
import {
  PlayerPrivateRemoteLeafEvaluator,
} from "./player-private-remote-leaf-evaluator.js";
import type {
  PlayerPrivateWorkerIdentity,
  PlayerPrivateWorkerTask,
} from "./player-private-worker-protocol.js";

const IDENTITY = {
  poolId: "pool-0123456789abcdef",
  workerId: 3,
  generation: 2,
  authenticationToken: "token-0123456789abcdef",
} as const satisfies PlayerPrivateWorkerIdentity;

const TASK = {
  schemaVersion: 2,
  kind: "player-private-worker-task",
  ...IDENTITY,
  taskId: 17,
  attempt: 2,
  assignedGames: [{
    gameIndex: 0,
    assignment: {
      seed: 101,
      parameterSeeds: { white: 1_101, black: 1_102 },
      whiteRuleId: "vegan",
      blackRuleId: "checkers",
    },
  }],
} as const satisfies PlayerPrivateWorkerTask;

const HISTORY_MOVE = {
  from: "e2",
  to: "e4",
  color: "white",
  piece: "pawn",
  san: "e4",
  flags: "quiet",
} as const;

const POSITION: LeafPosition = {
  authorityId: "standard-chess/v1",
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  turn: "white",
  legalMoves: [HISTORY_MOVE],
  history: [{
    from: "e7",
    to: "e5",
    color: "black",
    piece: "pawn",
    san: "e5",
    flags: "quiet",
  }],
  orthodoxCompatible: true,
  kingPassantActive: false,
};

describe("PlayerPrivateRemoteLeafEvaluator", () => {
  it("resolves an evaluation only from an authenticated correlated result", async () => {
    const harness = evaluatorHarness();
    const pending = harness.evaluator.evaluate(POSITION);

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({
      schemaVersion: 2,
      kind: "player-private-worker-evaluation-request",
      ...IDENTITY,
      taskId: TASK.taskId,
      attempt: TASK.attempt,
      evaluationId: 0,
    });
    expect(harness.messages[0]).not.toHaveProperty("position.history");

    expect(harness.evaluator.handleParentMessage(resultMessage())).toBe(true);
    await expect(pending).resolves.toBe(37);
  });

  it.each([
    {
      label: "pool identity",
      forge: { poolId: "forged-pool-0123456789" },
      error: "authentication",
    },
    {
      label: "worker identity",
      forge: { workerId: IDENTITY.workerId + 1 },
      error: "authentication",
    },
    {
      label: "generation identity",
      forge: { generation: IDENTITY.generation + 1 },
      error: "authentication",
    },
    {
      label: "authentication token",
      forge: { authenticationToken: "forged-token-0123456789" },
      error: "authentication",
    },
    {
      label: "task ID",
      forge: { taskId: TASK.taskId + 1 },
      error: "task correlation",
    },
    {
      label: "task attempt",
      forge: { attempt: TASK.attempt + 1 },
      error: "task correlation",
    },
    {
      label: "evaluation ID",
      forge: { evaluationId: 1 },
      error: "not pending",
    },
  ])(
    "rejects a forged $label without consuming or resolving the request",
    async ({ forge, error }) => {
      const harness = evaluatorHarness();
      const pending = harness.evaluator.evaluate(POSITION);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      expect(() => {
        harness.evaluator.handleParentMessage(resultMessage(forge));
      }).toThrow(error);
      await Promise.resolve();
      expect(settled).toBe(false);

      expect(harness.evaluator.handleParentMessage(resultMessage())).toBe(true);
      await expect(pending).resolves.toBe(37);
    },
  );

  it("sends one cancellation when abort wins and safely consumes a late result", async () => {
    const harness = evaluatorHarness();
    const controller = new AbortController();
    const pending = harness.evaluator.evaluate(POSITION, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.messages).toHaveLength(2);
    expect(harness.messages[1]).toEqual({
      schemaVersion: 2,
      kind: "player-private-worker-evaluation-cancel",
      ...IDENTITY,
      taskId: TASK.taskId,
      attempt: TASK.attempt,
      evaluationId: 0,
    });

    expect(harness.evaluator.handleParentMessage(resultMessage())).toBe(true);
    expect(() => {
      harness.evaluator.handleParentMessage(resultMessage());
    }).toThrow("not pending");
  });

  it("cancels an active evaluation exactly once when closed", async () => {
    const harness = evaluatorHarness();
    const pending = harness.evaluator.evaluate(POSITION);

    harness.evaluator.close();
    harness.evaluator.close();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.messages).toHaveLength(2);
    expect(harness.messages[1]).toEqual({
      schemaVersion: 2,
      kind: "player-private-worker-evaluation-cancel",
      ...IDENTITY,
      taskId: TASK.taskId,
      attempt: TASK.attempt,
      evaluationId: 0,
    });
    await expect(harness.evaluator.evaluate(POSITION)).rejects.toThrow(
      "evaluator is closed",
    );
  });
});

describe("player-private UCI leaf snapshots", () => {
  it("omits public history on the wire and restores an explicit empty history", () => {
    const snapshot = snapshotPlayerPrivateUciLeafPosition(POSITION);

    expect(Object.hasOwn(snapshot, "history")).toBe(false);
    expect(Object.keys(snapshot).sort()).toEqual([
      "authorityId",
      "fen",
      "kingPassantActive",
      "legalMoves",
      "orthodoxCompatible",
      "turn",
    ]);
    expect(snapshot.legalMoves).not.toBe(POSITION.legalMoves);
    expect(snapshot.legalMoves[0]).not.toBe(POSITION.legalMoves[0]);

    const restored = restorePlayerPrivateUciLeafPosition(snapshot);
    expect(restored).toEqual({ ...snapshot, history: [] });
    expect(restored.history).not.toBe(POSITION.history);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.history)).toBe(true);
  });
});

function evaluatorHarness(): {
  readonly evaluator: PlayerPrivateRemoteLeafEvaluator;
  readonly messages: unknown[];
} {
  const messages: unknown[] = [];
  const evaluator = new PlayerPrivateRemoteLeafEvaluator(
    "node-uci-leaf/v1/test",
    IDENTITY,
    {
      postMessage(value: unknown): void {
        messages.push(value);
      },
    },
  );
  evaluator.beginTask(TASK);
  return { evaluator, messages };
}

function resultMessage(
  overrides: Partial<PlayerPrivateWorkerEvaluationResult> = {},
): PlayerPrivateWorkerEvaluationResult {
  return {
    schemaVersion: 2,
    kind: "player-private-worker-evaluation-result",
    ...IDENTITY,
    taskId: TASK.taskId,
    attempt: TASK.attempt,
    evaluationId: 0,
    score: 37,
    ...overrides,
  };
}
