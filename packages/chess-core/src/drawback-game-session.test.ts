import { describe, expect, it } from "vitest";
import {
  botezGambitRule,
  checkersRule,
  unrestrictedRule,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { DrawbackGameSession } from "./drawback-game-session.js";

describe("DrawbackGameSession", () => {
  it("enforces drawbacks over geometric Drawback Chess moves", () => {
    const session = DrawbackGameSession.create(
      { white: checkersRule, black: unrestrictedRule },
      new Mulberry32(1),
      "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1",
    );
    expect(session.authorityLegalMoves().length).toBeGreaterThan(0);
    expect(session.legalMoves()).toEqual(session.authorityLegalMoves());
  });

  it("records king capture before any next-turn drawback loss", () => {
    const session = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(2),
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    );
    expect(session.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
        capturedKing: "black",
      },
    });
    expect(session.authorityLegalMoves()).toEqual([]);
    expect(session.legalMoves()).toEqual([]);
  });

  it("forks exact board and rule state without mutating the parent", () => {
    const parent = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(3),
    );
    const child = parent.fork();
    const parentSecrets = parent.exportSecretSnapshot();
    expect(child.move({ from: "e2", to: "e4" })).toMatchObject({ ok: true });
    expect(parent.fen).not.toBe(child.fen);
    expect(parent.history()).toHaveLength(0);
    expect(child.history()).toHaveLength(1);
    expect(parent.exportSecretSnapshot()).toEqual(parentSecrets);
    expect(child.exportSecretSnapshot().white.state).toEqual({
      movesApplied: 1,
    });
  });

  it("does not report orthodox checkmate or stalemate", () => {
    const session = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(4),
      "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
    );
    expect(session.result).toEqual({ kind: "active" });
    expect(session.legalMoves().length).toBeGreaterThan(0);
  });

  it("fails closed for rules not audited against the variant authority", () => {
    expect(() =>
      DrawbackGameSession.create(
        { white: botezGambitRule, black: unrestrictedRule },
        new Mulberry32(5),
      ),
    ).toThrow("has not been audited for capturable-king/v1");
  });
});
