import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  capturableKingIrresistibleRule,
  femmeFataleRule,
  nurturerRule,
  triplePlayRule,
  unrestrictedRule,
  youBestNotMissRule,
  resolveCapturableKingRule,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { DrawbackGameSession } from "./drawback-game-session.js";

describe("capturable-king drawback integration", () => {
  it("executes every authority-scoped normal-operation replay fixture", () => {
    const fixtures = [
      "femme-fatale",
      "nurturer",
      "triple-play",
      "you-best-not-miss",
      "irresistible",
    ].map((id) =>
      JSON.parse(readFileSync(
        new URL(
          `../../../data/fixtures/rules/capturable-king/${id}.json`,
          import.meta.url,
        ),
        "utf8",
      )) as {
        readonly ruleId: string;
        readonly authorityId: string;
        readonly seed: number;
        readonly initialFen: string;
        readonly moves: readonly {
          readonly from: string;
          readonly to: string;
          readonly promotion?: "knight" | "bishop" | "rook" | "queen";
        }[];
        readonly expectedWhiteParameters: unknown;
        readonly expectedResult: unknown;
      }
    );
    for (const fixture of fixtures) {
      expect(fixture.authorityId).toBe("capturable-king/v1");
      const session = DrawbackGameSession.create(
        {
          white: resolveCapturableKingRule(fixture.ruleId),
          black: unrestrictedRule,
        },
        new Mulberry32(fixture.seed),
        fixture.initialFen,
      );
      expect(
        session.exportSecretSnapshot().white.parameters,
      ).toEqual(fixture.expectedWhiteParameters);
      for (const command of fixture.moves) {
        const outcome = session.move(command);
        expect(
          outcome,
          `${fixture.ruleId} replay rejected ${command.from}${command.to}`,
        ).toMatchObject({ ok: true });
      }
      expect(session.result).toEqual(fixture.expectedResult);
    }
  });

  // drawback-evidence:femme-fatale:replay
  it("runs the Femme Fatale fixture as a literal queen king-capture", () => {
    const queen = DrawbackGameSession.create(
      { white: femmeFataleRule, black: unrestrictedRule },
      new Mulberry32(1),
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    );
    expect(queen.legalMoves()).toContainEqual(
      expect.objectContaining({
        from: "e7",
        to: "e8",
        piece: "queen",
        captured: "king",
      }),
    );
    expect(queen.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
        capturedKing: "black",
      },
    });

    const rook = DrawbackGameSession.create(
      { white: femmeFataleRule, black: unrestrictedRule },
      new Mulberry32(2),
      "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
    );
    expect(rook.authorityLegalMoves()).toContainEqual(
      expect.objectContaining({
        from: "e7",
        to: "e8",
        piece: "rook",
        captured: "king",
      }),
    );
    expect(rook.legalMoves()).not.toContainEqual(
      expect.objectContaining({ from: "e7", to: "e8" }),
    );
    expect(rook.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });
  });

  it("filters and terminates a real post-castling king-passant capture", () => {
    const forbiddenRook = DrawbackGameSession.create(
      { white: unrestrictedRule, black: femmeFataleRule },
      new Mulberry32(9),
      "5r1k/8/8/8/8/8/8/4K2R w K - 0 1",
    );
    expect(forbiddenRook.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    expect(forbiddenRook.publicPositionSnapshot().kingPassant).toEqual({
      victim: "white",
      kingSquare: "g1",
      targets: ["f1"],
    });
    const forbiddenRookCapture = forbiddenRook.authorityLegalMoves().find(
      (move) => move.from === "f8" && move.to === "f1",
    );
    expect(forbiddenRookCapture).toMatchObject({
      from: "f8",
      to: "f1",
      piece: "rook",
      captured: "king",
    });
    expect(forbiddenRookCapture?.flags).toContain("king-en-passant");
    expect(forbiddenRook.legalMoves()).not.toContainEqual(
      expect.objectContaining({ from: "f8", to: "f1" }),
    );
    expect(forbiddenRook.move({ from: "f8", to: "f1" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });

    const permittedQueen = DrawbackGameSession.create(
      { white: unrestrictedRule, black: femmeFataleRule },
      new Mulberry32(10),
      "5q1k/8/8/8/8/8/8/4K2R w K - 0 1",
    );
    expect(permittedQueen.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
    });
    const permittedQueenCapture = permittedQueen.legalMoves().find(
      (move) => move.from === "f8" && move.to === "f1",
    );
    expect(permittedQueenCapture).toMatchObject({
      from: "f8",
      to: "f1",
      piece: "queen",
      captured: "king",
    });
    expect(permittedQueenCapture?.flags).toContain("king-en-passant");
    expect(permittedQueen.move({ from: "f8", to: "f1" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "black",
        capturedKing: "white",
        method: "castling-en-passant",
      },
    });
  });

  // drawback-evidence:nurturer:replay
  it("unlocks Nurturer after a completed promotion and then captures the king", () => {
    const session = DrawbackGameSession.create(
      { white: nurturerRule, black: unrestrictedRule },
      new Mulberry32(3),
      "4k3/Pp2R3/8/8/8/8/8/K7 w - - 0 1",
    );
    expect(session.legalMoves()).not.toContainEqual(
      expect.objectContaining({ from: "e7", to: "e8" }),
    );
    expect(session.move({
      from: "a7",
      to: "a8",
      promotion: "queen",
    })).toMatchObject({ ok: true });
    expect(session.exportSecretSnapshot().white.state).toEqual({
      movesApplied: 1,
      hasPromotedPawn: true,
    });
    expect(session.move({ from: "b7", to: "b6" })).toMatchObject({
      ok: true,
    });
    expect(session.legalMoves()).toContainEqual(
      expect.objectContaining({
        from: "e7",
        to: "e8",
        captured: "king",
      }),
    );
    expect(session.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
      },
    });
  });

  it("does not infer a Nurturer unlock from a preloaded promoted-looking queen", () => {
    const session = DrawbackGameSession.create(
      { white: nurturerRule, black: unrestrictedRule },
      new Mulberry32(4),
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    );
    expect(session.exportSecretSnapshot().white.state).toEqual({
      movesApplied: 0,
      hasPromotedPawn: false,
    });
    expect(session.legalMoves()).not.toContainEqual(
      expect.objectContaining({ from: "e7", to: "e8" }),
    );
  });

  // drawback-evidence:triple-play:replay
  it("applies Triple Play's generated bishop threshold to authority moves", () => {
    const eligible = DrawbackGameSession.create(
      { white: triplePlayRule, black: unrestrictedRule },
      new Mulberry32(0),
      "4k3/4Q3/8/8/8/8/BBB5/K7 w - - 0 1",
    );
    expect(eligible.exportSecretSnapshot().white.parameters).toEqual({
      requiredType: "bishop",
    });
    expect(eligible.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: { kind: "king-capture" },
    });

    const ineligible = DrawbackGameSession.create(
      { white: triplePlayRule, black: unrestrictedRule },
      new Mulberry32(0),
      "4k3/4Q3/8/8/8/8/BB6/K7 w - - 0 1",
    );
    expect(ineligible.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });
  });

  // drawback-evidence:irresistible:replay
  it("retains a direct king capture beside real forced-adjacency moves", () => {
    const session = DrawbackGameSession.create(
      {
        white: capturableKingIrresistibleRule,
        black: unrestrictedRule,
      },
      new Mulberry32(12),
      "4k3/4R3/8/2N5/8/8/8/K7 w - - 0 1",
    );
    expect(session.authorityLegalMoves()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "c5", to: "d7" }),
        expect.objectContaining({
          from: "e7",
          to: "e8",
          captured: "king",
        }),
        expect.objectContaining({ from: "c5", to: "a4" }),
      ]),
    );
    expect(session.legalMoves()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "c5", to: "d7" }),
        expect.objectContaining({
          from: "e7",
          to: "e8",
          captured: "king",
        }),
      ]),
    );
    expect(session.legalMoves()).not.toContainEqual(
      expect.objectContaining({ from: "c5", to: "a4" }),
    );
    expect(session.move({ from: "c5", to: "a4" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });
    expect(session.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
        capturedKing: "black",
        method: "direct",
      },
    });
  });

  it("retains a generated king-passant capture beside Black adjacency moves", () => {
    const session = DrawbackGameSession.create(
      {
        white: unrestrictedRule,
        black: capturableKingIrresistibleRule,
      },
      new Mulberry32(13),
      "4q2k/8/8/8/8/3n4/8/4K2R w K - 0 1",
    );
    expect(session.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    const forcedAdjacency = session.legalMoves().find(
      (move) => move.from === "d3" && move.to === "f2",
    );
    const kingPassant = session.legalMoves().find(
      (move) => move.from === "e8" && move.to === "e1",
    );
    expect(forcedAdjacency).toMatchObject({
      piece: "knight",
    });
    expect(forcedAdjacency?.captured).toBeUndefined();
    expect(kingPassant).toMatchObject({
      piece: "queen",
      captured: "king",
    });
    expect(kingPassant?.flags).toContain("king-en-passant");
    expect(session.legalMoves()).not.toContainEqual(
      expect.objectContaining({ from: "d3", to: "b4" }),
    );
    expect(session.move({ from: "e8", to: "e1" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "black",
        capturedKing: "white",
        method: "castling-en-passant",
      },
    });
    expect(session.legalMoves()).toEqual([]);
  });

  it("forces a real en-passant move that creates king adjacency", () => {
    const session = DrawbackGameSession.create(
      {
        white: capturableKingIrresistibleRule,
        black: unrestrictedRule,
      },
      new Mulberry32(14),
      "8/2k5/8/3pP3/8/8/8/K7 w - d6 0 1",
    );
    const enPassant = session.legalMoves().find(
      (move) => move.from === "e5" && move.to === "d6",
    );
    expect(enPassant).toMatchObject({
      piece: "pawn",
      captured: "pawn",
    });
    expect(enPassant?.flags).toContain("en-passant");
    expect(session.legalMoves()).not.toContainEqual(
      expect.objectContaining({ from: "a1", to: "b1" }),
    );
    expect(session.move({ from: "e5", to: "d6" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
  });

  it("forces every real capture-promotion that creates king adjacency", () => {
    const session = DrawbackGameSession.create(
      {
        white: capturableKingIrresistibleRule,
        black: unrestrictedRule,
      },
      new Mulberry32(15),
      "2rk4/1P6/8/8/8/8/8/4K3 w - - 0 1",
    );
    const legalPromotions = session.legalMoves().filter(
      (move) => move.from === "b7" && move.to === "c8",
    );
    expect(legalPromotions.map((move) => move.promotion).sort()).toEqual([
      "bishop",
      "knight",
      "queen",
      "rook",
    ]);
    expect(session.legalMoves().some(
      (move) => move.from === "b7" && move.to === "b8",
    )).toBe(false);
    expect(session.move({
      from: "b7",
      to: "c8",
      promotion: "queen",
    })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
  });

  it("uses the real primary king endpoint when castling creates adjacency", () => {
    const session = DrawbackGameSession.create(
      {
        white: capturableKingIrresistibleRule,
        black: unrestrictedRule,
      },
      new Mulberry32(16),
      "8/8/8/8/8/8/1k6/R3K3 w Q - 0 1",
    );
    expect(session.legalMoves()).toContainEqual(
      expect.objectContaining({
        from: "e1",
        to: "c1",
        piece: "king",
      }),
    );
    expect(session.move({ from: "e1", to: "c1" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    expect(session.move({ from: "b2", to: "c1" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "black",
        capturedKing: "white",
        method: "direct",
      },
    });
    expect(session.legalMoves()).toEqual([]);
  });

  // drawback-evidence:you-best-not-miss:startOfTurnLoss
  it("loses at the next affected turn when the opponent escapes every king capture", () => {
    const session = DrawbackGameSession.create(
      { white: youBestNotMissRule, black: unrestrictedRule },
      new Mulberry32(5),
      "7k/8/8/8/8/8/8/R3K3 w - - 0 1",
    );
    expect(session.move({ from: "a1", to: "a8" })).toMatchObject({
      ok: true,
    });
    expect(session.exportSecretSnapshot().white.state).toEqual({
      movesApplied: 1,
      mustCaptureKingNextTurn: true,
    });
    expect(session.move({ from: "h8", to: "g7" })).toMatchObject({
      ok: true,
      result: {
        kind: "drawback-loss",
        loss: {
          ruleId: "you-best-not-miss",
          color: "white",
        },
      },
    });
  });

  // drawback-evidence:you-best-not-miss:replay
  it("gives successful king capture precedence over the armed obligation", () => {
    const session = DrawbackGameSession.create(
      { white: youBestNotMissRule, black: unrestrictedRule },
      new Mulberry32(6),
      "7k/1p6/8/8/8/8/8/R3K3 w - - 0 1",
    );
    expect(session.move({ from: "a1", to: "a8" })).toMatchObject({
      ok: true,
    });
    expect(session.move({ from: "b7", to: "b6" })).toMatchObject({
      ok: true,
    });
    expect(session.legalMoves()).toEqual([
      expect.objectContaining({
        from: "a8",
        to: "h8",
        captured: "king",
      }),
    ]);
    expect(session.move({ from: "a8", to: "h8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
      },
    });
  });

  it("satisfies an armed obligation through a generated king-passant right", () => {
    const session = DrawbackGameSession.create(
      { white: unrestrictedRule, black: youBestNotMissRule },
      new Mulberry32(11),
      "5q1k/p7/8/8/1b6/8/8/4K2R b K - 0 1",
    );
    expect(session.move({ from: "a7", to: "a6" })).toMatchObject({
      ok: true,
    });
    expect(session.exportSecretSnapshot().black.state).toEqual({
      movesApplied: 1,
      mustCaptureKingNextTurn: true,
    });
    expect(session.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    const obligationCapture = session.legalMoves().find(
      (move) => move.from === "f8" && move.to === "f1",
    );
    expect(obligationCapture).toMatchObject({
      from: "f8",
      to: "f1",
      captured: "king",
    });
    expect(obligationCapture?.flags).toContain("king-en-passant");
    expect(
      session.legalMoves().every((move) => move.captured === "king"),
    ).toBe(true);
    expect(session.move({ from: "f8", to: "f1" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "black",
        capturedKing: "white",
        method: "castling-en-passant",
      },
    });
  });

  it("keeps delayed-obligation state isolated by player color", () => {
    const session = DrawbackGameSession.create(
      {
        white: youBestNotMissRule,
        black: youBestNotMissRule,
      },
      new Mulberry32(7),
      "7k/1p6/8/8/8/8/8/R3K3 w - - 0 1",
    );
    expect(session.move({ from: "a1", to: "a8" })).toMatchObject({
      ok: true,
    });
    const afterWhite = session.exportSecretSnapshot();
    expect(afterWhite.white.state).toMatchObject({
      mustCaptureKingNextTurn: true,
    });
    expect(afterWhite.black.state).toEqual({
      movesApplied: 0,
      mustCaptureKingNextTurn: false,
    });
    expect(session.move({ from: "b7", to: "b6" })).toMatchObject({
      ok: true,
    });
    const afterBlack = session.exportSecretSnapshot();
    expect(afterBlack.white.state).toEqual(afterWhite.white.state);
    expect(afterBlack.black.state).toEqual({
      movesApplied: 1,
      mustCaptureKingNextTurn: false,
    });
  });

  it("lets opponent king capture terminate before the affected obligation returns", () => {
    const session = DrawbackGameSession.create(
      { white: youBestNotMissRule, black: unrestrictedRule },
      new Mulberry32(8),
      "7k/8/8/8/8/8/4q3/R3K3 w - - 0 1",
    );
    expect(session.move({ from: "a1", to: "a8" })).toMatchObject({
      ok: true,
    });
    expect(session.move({ from: "e2", to: "e1" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "black",
        capturedKing: "white",
      },
    });
  });
});
