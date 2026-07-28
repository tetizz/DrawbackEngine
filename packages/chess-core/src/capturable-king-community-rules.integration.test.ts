import { describe, expect, it } from "vitest";
import {
  alternatorRule,
  greedyRule,
  hopscotchRule,
  outOfBreathRule,
  queenBeeRule,
  unrestrictedRule,
  type ChessMove,
  type DrawbackRule,
} from "@drawbackengine/drawback-engine";
import {
  Mulberry32,
} from "@drawbackengine/shared";
import { CapturableKingPosition } from "./capturable-king-position.js";
import { DrawbackGameSession } from "./drawback-game-session.js";

const COMMUNITY_V4_RULES = [
  greedyRule,
  outOfBreathRule,
  queenBeeRule,
  alternatorRule,
  hopscotchRule,
] as const;

function whiteSession<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
  fen: string,
) {
  return DrawbackGameSession.create(
    { white: rule, black: unrestrictedRule },
    new Mulberry32(0xc04_0001),
    fen,
  );
}

function blackSession<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
  fen: string,
) {
  return DrawbackGameSession.create(
    { white: unrestrictedRule, black: rule },
    new Mulberry32(0xc04_0002),
    fen,
  );
}

function findMove(
  moves: readonly ChessMove[],
  from: string,
  to: string,
  promotion?: ChessMove["promotion"],
): ChessMove | undefined {
  return moves.find(
    (move) =>
      move.from === from
      && move.to === to
      && move.promotion === promotion,
  );
}

function expectImmutableAuthorityMask<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
): void {
  const position = CapturableKingPosition.fromFen(
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  );
  const moves = Object.freeze(
    position.legalMoves().map((move) => Object.freeze({ ...move })),
  );
  const before = structuredClone(moves);
  const parameters = rule.generateParameters(
    new Mulberry32(0xc04_1000),
  );
  const view = {
    fen: position.fen,
    turn: position.turn,
    ply: 0,
    history: Object.freeze([]),
  } as const;
  const state = rule.initialize({
    color: position.turn,
    parameters,
    position: view,
  });
  const filtered = rule.filterLegalMoves(
    {
      color: position.turn,
      parameters,
      state,
      position: view,
    },
    moves,
  );
  expect(moves).toEqual(before);
  expect(filtered).not.toBe(moves);
  expect(filtered.every((move) => moves.includes(move))).toBe(true);
}

describe("capturable-king community v4 metadata", () => {
  it("scopes exactly five implemented-unverified rules to both authorities", () => {
    expect(COMMUNITY_V4_RULES.map(({ id }) => id)).toEqual([
      "greedy",
      "out-of-breath",
      "queen-bee",
      "alternator",
      "hopscotch",
    ]);
    for (const rule of COMMUNITY_V4_RULES) {
      expect(rule.verification).toBe("implemented-unverified");
      expect(rule.supportedAuthorities).toEqual([
        "standard-chess/v1",
        "capturable-king/v1",
      ]);
      expect(Object.isFrozen(rule.supportedAuthorities)).toBe(true);
    }
    expectImmutableAuthorityMask(greedyRule);
    expectImmutableAuthorityMask(outOfBreathRule);
    expectImmutableAuthorityMask(queenBeeRule);
    expectImmutableAuthorityMask(alternatorRule);
    expectImmutableAuthorityMask(hopscotchRule);
  });
});

describe("Greedy under capturable-king/v1", () => {
  it.each([
    {
      color: "white",
      fen: "3k4/8/8/8/8/1p6/8/K2Q4 w - - 0 1",
      kingCapture: ["d1", "d8"],
      pawnCapture: ["d1", "b3"],
    },
    {
      color: "black",
      fen: "3q3k/8/1P6/8/8/8/8/3K4 b - - 0 1",
      kingCapture: ["d8", "d1"],
      pawnCapture: ["d8", "b6"],
    },
  ] as const)(
    "makes the $color king the maximum-value capture target",
    ({ color, fen, kingCapture, pawnCapture }) => {
      const session = color === "white"
        ? whiteSession(greedyRule, fen)
        : blackSession(greedyRule, fen);
      expect(findMove(
        session.authorityLegalMoves(),
        pawnCapture[0],
        pawnCapture[1],
      )).toMatchObject({ captured: "pawn" });
      expect(findMove(
        session.authorityLegalMoves(),
        kingCapture[0],
        kingCapture[1],
      )).toMatchObject({ captured: "king" });
      expect(findMove(
        session.legalMoves(),
        pawnCapture[0],
        pawnCapture[1],
      )).toBeUndefined();
      expect(findMove(
        session.legalMoves(),
        kingCapture[0],
        kingCapture[1],
      )).toMatchObject({ captured: "king" });
      expect(session.legalMoves().some(
        (move) => move.captured === undefined,
      )).toBe(true);
      expect(session.move({
        from: pawnCapture[0],
        to: pawnCapture[1],
      })).toMatchObject({
        ok: false,
        reason: "drawback-forbidden",
      });
      expect(session.move({
        from: kingCapture[0],
        to: kingCapture[1],
      })).toMatchObject({
        ok: true,
        result: {
          kind: "king-capture",
          winner: color,
          method: "direct",
        },
      });
    },
  );
});

describe("Out of Breath under capturable-king/v1", () => {
  it("allows a first king move to capture the opposing king", () => {
    const session = whiteSession(
      outOfBreathRule,
      "4k3/4K3/8/8/8/8/8/8 w - - 0 1",
    );
    expect(session.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
        method: "direct",
      },
    });
  });

  it("forbids a direct king capture after the king has already moved", () => {
    const session = whiteSession(
      outOfBreathRule,
      "4k3/p7/4K3/8/8/8/7P/8 w - - 0 1",
    );
    expect(session.move({ from: "e6", to: "e7" })).toMatchObject({
      ok: true,
    });
    expect(session.exportSecretSnapshot().white.state).toEqual({
      kingMoves: 1,
    });
    expect(session.move({ from: "a7", to: "a6" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    expect(findMove(
      session.authorityLegalMoves(),
      "e7",
      "e8",
    )).toMatchObject({
      piece: "king",
      captured: "king",
    });
    expect(findMove(session.legalMoves(), "e7", "e8")).toBeUndefined();
    expect(session.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });
  });

  it("counts capturable-authority castling as the one king move", () => {
    const session = whiteSession(
      outOfBreathRule,
      "4k3/p7/8/8/8/8/8/4K2R w K - 0 1",
    );
    expect(session.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    expect(session.exportSecretSnapshot().white.state).toEqual({
      kingMoves: 1,
    });
    expect(session.move({ from: "a7", to: "a6" })).toMatchObject({
      ok: true,
    });
    expect(session.authorityLegalMoves().some(
      (move) => move.piece === "king",
    )).toBe(true);
    expect(session.legalMoves().some(
      (move) => move.piece === "king",
    )).toBe(false);
  });
});

describe("Queen Bee under capturable-king/v1", () => {
  it("allows a queen's first capture to end the game", () => {
    const session = whiteSession(
      queenBeeRule,
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    );
    expect(session.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
        method: "direct",
      },
    });
  });

  it("freezes a later queen king-capture after an ordinary queen capture", () => {
    const session = whiteSession(
      queenBeeRule,
      "4k3/p7/8/8/8/8/4p3/K3Q3 w - - 0 1",
    );
    expect(session.move({ from: "e1", to: "e2" })).toMatchObject({
      ok: true,
    });
    expect(session.exportSecretSnapshot().white.state).toEqual({
      queenCaptureOccurred: true,
    });
    expect(session.move({ from: "a7", to: "a6" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    expect(findMove(
      session.authorityLegalMoves(),
      "e2",
      "e8",
    )).toMatchObject({
      piece: "queen",
      captured: "king",
    });
    expect(findMove(session.legalMoves(), "e2", "e8")).toBeUndefined();
    expect(session.move({ from: "e2", to: "e8" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });
  });
});

describe("Alternator under capturable-king/v1", () => {
  it("allows a non-pawn king capture after a pawn move", () => {
    const session = whiteSession(
      alternatorRule,
      "4k3/4R2p/8/8/8/8/P7/K7 w - - 0 1",
    );
    expect(session.move({ from: "a2", to: "a3" })).toMatchObject({
      ok: true,
    });
    expect(session.move({ from: "h7", to: "h6" })).toMatchObject({
      ok: true,
    });
    expect(session.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
        method: "direct",
      },
    });
  });

  it("forbids a non-pawn king capture after a non-pawn move", () => {
    const session = whiteSession(
      alternatorRule,
      "4k3/7p/4R3/8/8/8/P7/K7 w - - 0 1",
    );
    expect(session.move({ from: "e6", to: "e7" })).toMatchObject({
      ok: true,
    });
    expect(session.exportSecretSnapshot().white.state).toEqual({
      previousClass: true,
    });
    expect(session.move({ from: "h7", to: "h6" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    expect(findMove(
      session.authorityLegalMoves(),
      "e7",
      "e8",
    )).toMatchObject({ captured: "king" });
    expect(findMove(session.legalMoves(), "e7", "e8")).toBeUndefined();
  });

  it("classifies a capture-promotion as a pawn king-capture", () => {
    const session = whiteSession(
      alternatorRule,
      "1k6/P1p5/8/8/8/8/8/4K2R w - - 0 1",
    );
    expect(session.move({ from: "h1", to: "h2" })).toMatchObject({
      ok: true,
    });
    expect(session.move({ from: "c7", to: "c6" })).toMatchObject({
      ok: true,
    });
    expect(findMove(
      session.legalMoves(),
      "a7",
      "b8",
      "queen",
    )).toMatchObject({
      piece: "pawn",
      captured: "king",
      promotion: "queen",
    });
    expect(session.move({
      from: "a7",
      to: "b8",
      promotion: "queen",
    })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
        method: "direct",
      },
    });
  });

  it("classifies castling as non-pawn and ordinary en-passant as pawn", () => {
    const castle = whiteSession(
      alternatorRule,
      "4k3/p7/8/8/8/8/P7/4K2R w K - 0 1",
    );
    expect(castle.move({ from: "a2", to: "a3" })).toMatchObject({
      ok: true,
    });
    expect(castle.move({ from: "a7", to: "a6" })).toMatchObject({
      ok: true,
    });
    expect(findMove(castle.legalMoves(), "e1", "g1")?.flags)
      .toContain("kingside-castle");
    expect(castle.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    expect(castle.exportSecretSnapshot().white.state).toEqual({
      previousClass: true,
    });

    const enPassant = whiteSession(
      alternatorRule,
      "7k/3p4/8/4P3/8/8/8/R6K w - - 0 1",
    );
    expect(enPassant.move({ from: "a1", to: "a2" })).toMatchObject({
      ok: true,
    });
    expect(enPassant.move({ from: "d7", to: "d5" })).toMatchObject({
      ok: true,
    });
    const capture = findMove(enPassant.legalMoves(), "e5", "d6");
    expect(capture).toMatchObject({
      piece: "pawn",
      captured: "pawn",
    });
    expect(capture?.flags).toContain("en-passant");
    expect(enPassant.move({ from: "e5", to: "d6" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    expect(enPassant.exportSecretSnapshot().white.state).toEqual({
      previousClass: false,
    });
  });
});

describe("Hopscotch under capturable-king/v1", () => {
  it("uses the direct king-capture destination color", () => {
    const allowed = whiteSession(
      hopscotchRule,
      "4k3/7p/4R3/8/8/8/8/K7 w - - 0 1",
    );
    expect(allowed.move({ from: "e6", to: "e7" })).toMatchObject({
      ok: true,
    });
    expect(allowed.move({ from: "h7", to: "h6" })).toMatchObject({
      ok: true,
    });
    expect(allowed.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
        method: "direct",
      },
    });

    const forbidden = whiteSession(
      hopscotchRule,
      "4k3/7p/3Q4/8/8/8/8/K7 w - - 0 1",
    );
    expect(forbidden.move({ from: "d6", to: "d7" })).toMatchObject({
      ok: true,
    });
    expect(forbidden.move({ from: "h7", to: "h6" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    expect(findMove(
      forbidden.authorityLegalMoves(),
      "d7",
      "e8",
    )).toMatchObject({ captured: "king" });
    expect(findMove(forbidden.legalMoves(), "d7", "e8")).toBeUndefined();
  });

  it.each([
    {
      priorMove: ["a7", "a5"],
      allowed: true,
    },
    {
      priorMove: ["a7", "a6"],
      allowed: false,
    },
  ] as const)(
    "classifies a king-passant landing square after $priorMove",
    ({ priorMove, allowed }) => {
      const session = blackSession(
        hopscotchRule,
        "5q1k/p7/8/8/1b6/8/8/4K2R b K - 0 1",
      );
      expect(session.move({
        from: priorMove[0],
        to: priorMove[1],
      })).toMatchObject({
        ok: true,
      });
      expect(session.move({ from: "e1", to: "g1" })).toMatchObject({
        ok: true,
        result: { kind: "active" },
      });
      const authorityCapture = findMove(
        session.authorityLegalMoves(),
        "f8",
        "f1",
      );
      expect(authorityCapture).toMatchObject({
        piece: "queen",
        captured: "king",
      });
      expect(authorityCapture?.flags).toContain("king-en-passant");
      expect(
        findMove(session.legalMoves(), "f8", "f1") !== undefined,
      ).toBe(allowed);
      if (allowed) {
        expect(session.move({ from: "f8", to: "f1" })).toMatchObject({
          ok: true,
          result: {
            kind: "king-capture",
            winner: "black",
            method: "castling-en-passant",
          },
        });
      } else {
        expect(session.move({ from: "f8", to: "f1" })).toMatchObject({
          ok: false,
          reason: "drawback-forbidden",
        });
      }
    },
  );
});
