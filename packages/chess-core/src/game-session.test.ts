import { describe, expect, it } from "vitest";
import type { DrawbackRule } from "@drawbackengine/drawback-engine";
import {
  bloodthirstyRule,
  botezGambitRule,
  unspoolingRule,
  unrestrictedRule,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { GameSession } from "./game-session.js";

describe("GameSession", () => {
  it("enforces standard chess legality", () => {
    const session = new GameSession(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(1),
    );
    expect(session.move({ from: "e2", to: "e5" })).toMatchObject({
      ok: false,
      reason: "not-standard-legal",
    });
  });

  it("is deterministic for the same commands and seed", () => {
    const create = () =>
      new GameSession(
        { white: unrestrictedRule, black: unrestrictedRule },
        new Mulberry32(17),
      );
    const first = create();
    const second = create();
    const commands = [
      { from: "e2", to: "e4" },
      { from: "e7", to: "e5" },
      { from: "g1", to: "f3" },
    ] as const;
    expect(commands.map((command) => first.move(command))).toEqual(
      commands.map((command) => second.move(command)),
    );
    expect(first.fen).toBe(second.fen);
  });

  it("returns defensive move-array copies", () => {
    const session = new GameSession(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(3),
    );
    const moves = session.legalMoves();
    expect(moves).toHaveLength(20);
    expect(session.legalMoves()).toHaveLength(20);
  });

  it("records an explicit drawback loss when every ordinary move is filtered", () => {
    const noMovesRule: DrawbackRule<Record<string, never>, Record<string, never>> = {
      id: "test-no-moves",
      name: "No moves",
      description: "Test rule.",
      verification: "verified",
      generateParameters: () => ({}),
      initialize: () => ({}),
      filterLegalMoves: () => [],
      applyMove: () => ({}),
      checkStartOfTurnLoss: () => null,
    };
    const session = new GameSession(
      { white: noMovesRule, black: unrestrictedRule },
      new Mulberry32(3),
    );
    expect(session.result).toEqual({
      kind: "drawback-loss",
      loss: {
        ruleId: "test-no-moves",
        color: "white",
        reason: "The drawback forbids every otherwise legal move.",
      },
    });
  });

  it("uses standard checkmate when standard chess has no moves", () => {
    const session = new GameSession(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(9),
      "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1",
    );
    expect(session.result).toEqual({ kind: "checkmate", winner: "white" });
  });

  it("delays Unspooling exhaustion until the affected player's next turn", () => {
    const nearlyExhausted = {
      ...unspoolingRule,
      initialize: () => ({ movesApplied: 20, distanceUsed: 99 }),
    };
    const session = new GameSession(
      { white: nearlyExhausted, black: unrestrictedRule },
      new Mulberry32(9),
      "4k3/8/8/8/8/8/8/R3K3 w - - 0 1",
    );
    expect(session.move({ from: "a1", to: "a2" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    expect(session.move({ from: "e8", to: "e7" })).toMatchObject({
      ok: true,
      result: {
        kind: "drawback-loss",
        loss: { ruleId: "unspooling", color: "white" },
      },
    });
  });

  it("lets a final-unit checkmate supersede a later Unspooling loss", () => {
    const nearlyExhausted = {
      ...unspoolingRule,
      initialize: () => ({ movesApplied: 20, distanceUsed: 99 }),
    };
    const session = new GameSession(
      { white: nearlyExhausted, black: unrestrictedRule },
      new Mulberry32(10),
      "7k/R7/6K1/8/8/8/8/8 w - - 0 1",
    );
    expect(session.move({ from: "a7", to: "a8" })).toMatchObject({
      ok: true,
      result: { kind: "checkmate", winner: "white" },
    });
  });

  it("enforces Bloodthirsty's capture deadline through the session loss path", () => {
    const session = new GameSession(
      { white: bloodthirstyRule, black: unrestrictedRule },
      new Mulberry32(4),
    );
    const commands = [
      { from: "a2", to: "a3" },
      { from: "a7", to: "a6" },
      { from: "b2", to: "b3" },
      { from: "b7", to: "b6" },
      { from: "c2", to: "c3" },
      { from: "c7", to: "c6" },
      { from: "d2", to: "d3" },
      { from: "d7", to: "d6" },
      { from: "e2", to: "e3" },
      { from: "e7", to: "e6" },
    ] as const;
    for (const command of commands) {
      expect(session.move(command).ok).toBe(true);
    }
    expect(session.result).toEqual({
      kind: "drawback-loss",
      loss: {
        ruleId: "bloodthirsty",
        color: "white",
        reason: "The drawback forbids every otherwise legal move.",
      },
    });
  });

  it("evaluates FEN-based drawback deadlines on session initialization", () => {
    const session = new GameSession(
      { white: botezGambitRule, black: unrestrictedRule },
      new Mulberry32(11),
      "3qk3/8/8/8/8/8/8/3QK3 w - - 0 11",
    );
    expect(session.result).toMatchObject({
      kind: "drawback-loss",
      loss: {
        ruleId: "botez-gambit",
        color: "white",
      },
    });
  });

  it("passes complete pre-move and post-move positions to rule transitions", () => {
    let observed:
      | {
          readonly beforeFen: string;
          readonly afterFen: string;
          readonly beforeHistory: number;
          readonly afterHistory: number;
        }
      | undefined;
    const observingRule: DrawbackRule<Record<string, never>, Record<string, never>> = {
      id: "test-transition-observer",
      name: "Transition observer",
      description: "Test rule.",
      verification: "verified",
      generateParameters: () => ({}),
      initialize: () => ({}),
      filterLegalMoves: (context, moves) => {
        void context;
        return [...moves];
      },
      applyMove: (context) => {
        observed = {
          beforeFen: context.position.fen,
          afterFen: context.positionAfterMove.fen,
          beforeHistory: context.position.history.length,
          afterHistory: context.positionAfterMove.history.length,
        };
        return {};
      },
      checkStartOfTurnLoss: () => null,
    };
    const session = new GameSession(
      { white: observingRule, black: unrestrictedRule },
      new Mulberry32(12),
    );
    const initialFen = session.fen;
    expect(session.move({ from: "e2", to: "e4" }).ok).toBe(true);
    expect(observed).toEqual({
      beforeFen: initialFen,
      afterFen: session.fen,
      beforeHistory: 0,
      afterHistory: 1,
    });
  });

  it("exports defensive engine-only secret snapshots without leaking them into observations", () => {
    interface Parameters {
      readonly hidden: { readonly file: string };
    }
    interface State {
      readonly moves: number;
    }
    const secretRule: DrawbackRule<State, Parameters> = {
      id: "test-secret",
      name: "Secret",
      description: "Test rule.",
      verification: "verified",
      generateParameters: () => ({ hidden: { file: "c" } }),
      initialize: () => ({ moves: 0 }),
      filterLegalMoves: (_context, moves) => [...moves],
      applyMove: (context) => ({ moves: context.state.moves + 1 }),
      checkStartOfTurnLoss: () => null,
    };
    const session = new GameSession(
      { white: secretRule, black: unrestrictedRule },
      new Mulberry32(4),
    );
    const snapshot = session.exportSecretSnapshot();
    (snapshot.white.parameters.hidden as { file: string }).file = "h";
    (snapshot.white.state as { moves: number }).moves = 99;

    expect(session.exportSecretSnapshot().white).toEqual({
      drawbackId: "test-secret",
      parameters: { hidden: { file: "c" } },
      state: { moves: 0 },
    });
    const outcome = session.move({ from: "e2", to: "e4" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.observation.fenAfter).toBe(session.fen);
      expect(outcome.observation).not.toHaveProperty("parameters");
      expect(outcome.observation).not.toHaveProperty("state");
    }
    expect(session.exportSecretSnapshot().white.state).toEqual({ moves: 1 });
  });
});
