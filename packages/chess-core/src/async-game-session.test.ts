import { describe, expect, it } from "vitest";
import {
  handAndGigabrainRule,
  ichtyophobeRule,
  veganRule,
  type ExternalTurnConstraintProvider,
  type ExternalTurnConstraintRequest,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import {
  AsyncGameSession,
  AsyncSessionPreparationError,
} from "./async-game-session.js";

class FakeProvider implements ExternalTurnConstraintProvider {
  public readonly requests: ExternalTurnConstraintRequest[] = [];
  public failuresRemaining = 0;

  public constructor(private readonly bestMove?: string) {}

  public resolve(request: ExternalTurnConstraintRequest) {
    this.requests.push(request);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("synthetic provider failure");
    }
    const bestMove =
      this.bestMove !== undefined &&
      request.ordinaryRootMoves.includes(this.bestMove)
        ? this.bestMove
        : request.ordinaryRootMoves[0];
    if (bestMove === undefined) {
      throw new Error("No root move was supplied.");
    }
    return Promise.resolve(Object.freeze({
      provider: request.provider,
      policyId: request.policyId,
      positionKey: request.positionKey,
      bestMoveUci: bestMove,
      requestDigest: "ab".repeat(32),
      engineFingerprint: "fake-evaluator-v1",
    }));
  }

  public async dispose(): Promise<void> {}
}

const controlRule = veganRule;

describe("AsyncGameSession", () => {
  it("prepares an evaluator-backed Hand turn before exposing legal moves", async () => {
    const provider = new FakeProvider("e2e4");
    const session = await AsyncGameSession.create(
      { white: handAndGigabrainRule, black: controlRule },
      new Mulberry32(1),
      { provider },
    );

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.ordinaryRootMoves).toHaveLength(20);
    expect(session.legalMoves()).toHaveLength(16);
    expect(session.legalMoves().every((move) => move.piece === "pawn")).toBe(
      true,
    );

    const outcome = await session.move({ from: "e2", to: "e4" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.observation.externalConstraint?.bestMoveUci).toBe("e2e4");
    }
  });

  it("removes the evaluator best move for Ichtyophobe", async () => {
    const session = await AsyncGameSession.create(
      { white: ichtyophobeRule, black: controlRule },
      new Mulberry32(2),
      { provider: new FakeProvider("e2e4") },
    );

    expect(
      session.legalMoves().some((move) => move.from === "e2" && move.to === "e4"),
    ).toBe(false);
    expect(session.legalMoves()).toHaveLength(19);
  });

  it("fails closed when an external rule has no provider", async () => {
    await expect(
      AsyncGameSession.create(
        { white: handAndGigabrainRule, black: controlRule },
        new Mulberry32(3),
      ),
    ).rejects.toMatchObject({
      name: "AsyncSessionPreparationError",
      moveApplied: false,
    });
  });

  it("does not call the evaluator for an already terminal position", async () => {
    const provider = new FakeProvider();
    const session = await AsyncGameSession.create(
      { white: controlRule, black: handAndGigabrainRule },
      new Mulberry32(4),
      {
        provider,
        fen: "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1",
      },
    );

    expect(session.result).toEqual({ kind: "checkmate", winner: "white" });
    expect(provider.requests).toHaveLength(0);
  });

  it("keeps an applied move and supports retry after next-turn preparation fails", async () => {
    const provider = new FakeProvider();
    const session = await AsyncGameSession.create(
      { white: handAndGigabrainRule, black: handAndGigabrainRule },
      new Mulberry32(5),
      { provider },
    );
    provider.failuresRemaining = 1;

    let failure: unknown;
    try {
      await session.move({ from: "a2", to: "a3" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AsyncSessionPreparationError);
    expect(failure).toMatchObject({ moveApplied: true });
    expect(session.fen).not.toContain(" w ");
    expect(() => session.legalMoves()).toThrow(AsyncSessionPreparationError);

    const recovered = await session.retryPreparation();
    expect(recovered?.observation.move).toMatchObject({
      from: "a2",
      to: "a3",
    });
    expect(session.legalMoves().length).toBeGreaterThan(0);
    expect(provider.requests).toHaveLength(3);
  });

  it("runs ordinary synchronous rules without an evaluator", async () => {
    const session = await AsyncGameSession.create(
      { white: controlRule, black: controlRule },
      new Mulberry32(6),
    );

    expect(session.ordinaryLegalMoves()).toHaveLength(20);
    expect(session.legalMoves()).toHaveLength(20);
  });

  it("prepares the same public evaluator fact for a synchronous true rule", async () => {
    const provider = new FakeProvider("e2e4");
    const session = await AsyncGameSession.create(
      { white: controlRule, black: controlRule },
      new Mulberry32(7),
      { provider },
    );

    const outcome = await session.move({ from: "e2", to: "e4" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.observation.externalConstraint).toMatchObject({
        bestMoveUci: "e2e4",
        engineFingerprint: "fake-evaluator-v1",
      });
    }
  });
});
