import { describe, expect, it } from "vitest";
import {
  champingAtTheBitRule,
  controlCenterRule,
  elephantsFearMiceRule,
  farSightedRule,
  indecisiveRule,
  professionalCourtesyRule,
  scentOfBloodRule,
  shadowQueenRule,
  snipersRule,
  stayAtHomeMomRule,
  stopStallingRule,
  unrestrictedRule,
  whitesOfTheirEyesRule,
  type ChessMove,
  type DrawbackRule,
  type NoParameters,
  type PromotionPiece,
  type StatelessRuleState,
} from "@drawbackengine/drawback-engine";
import {
  Mulberry32,
  type PlayerColor,
} from "@drawbackengine/shared";
import { CapturableKingPosition } from "./capturable-king-position.js";
import { DrawbackGameSession } from "./drawback-game-session.js";

type DeclarativeRule = DrawbackRule<StatelessRuleState, NoParameters>;

interface MoveCase {
  readonly rule: DeclarativeRule;
  readonly color: PlayerColor;
  readonly fen: string;
  readonly from: string;
  readonly to: string;
  readonly promotion?: PromotionPiece;
}

const DECLARATIVE_RULES = [
  farSightedRule,
  stopStallingRule,
  whitesOfTheirEyesRule,
  elephantsFearMiceRule,
  controlCenterRule,
  indecisiveRule,
  professionalCourtesyRule,
  scentOfBloodRule,
  champingAtTheBitRule,
  shadowQueenRule,
  stayAtHomeMomRule,
  snipersRule,
] as const;

const ALLOWED_DIRECT_KING_CAPTURES = [
  {
    rule: farSightedRule,
    color: "white",
    fen: "4k3/8/8/8/4R3/8/8/K7 w - - 0 1",
    from: "e4",
    to: "e8",
  },
  {
    rule: stopStallingRule,
    color: "black",
    fen: "7k/8/8/8/8/8/4r3/4K3 b - - 0 1",
    from: "e2",
    to: "e1",
  },
  {
    rule: whitesOfTheirEyesRule,
    color: "white",
    fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
    from: "e7",
    to: "e8",
  },
  {
    rule: elephantsFearMiceRule,
    color: "black",
    fen: "7k/8/8/8/8/8/4r3/4K3 b - - 0 1",
    from: "e2",
    to: "e1",
  },
  {
    rule: controlCenterRule,
    color: "white",
    fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
    from: "e7",
    to: "e8",
  },
  {
    rule: indecisiveRule,
    color: "black",
    fen: "7k/8/8/8/8/8/4r3/4K3 b - - 0 1",
    from: "e2",
    to: "e1",
  },
  {
    rule: professionalCourtesyRule,
    color: "white",
    fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
    from: "e7",
    to: "e8",
  },
  {
    rule: scentOfBloodRule,
    color: "black",
    fen: "7k/8/8/8/8/8/4r3/4K3 b - - 0 1",
    from: "e2",
    to: "e1",
  },
  {
    rule: champingAtTheBitRule,
    color: "white",
    fen: "8/8/8/5k2/4P3/8/8/K7 w - - 0 1",
    from: "e4",
    to: "f5",
  },
  {
    rule: shadowQueenRule,
    color: "black",
    fen: "7k/8/8/8/8/8/4q3/4K3 b - - 0 1",
    from: "e2",
    to: "e1",
  },
  {
    rule: stayAtHomeMomRule,
    color: "black",
    fen: "k2q4/3K4/8/8/8/8/8/8 b - - 0 1",
    from: "d8",
    to: "d7",
  },
  {
    rule: snipersRule,
    color: "black",
    fen: "7k/8/8/7b/8/8/8/3K4 b - - 0 1",
    from: "h5",
    to: "d1",
  },
] as const satisfies readonly MoveCase[];

const FORBIDDEN_DIRECT_KING_CAPTURES = [
  {
    rule: farSightedRule,
    color: "white",
    fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
    from: "e7",
    to: "e8",
  },
  {
    rule: stopStallingRule,
    color: "black",
    fen: "7k/8/8/8/8/8/4r2K/8 b - - 0 1",
    from: "e2",
    to: "h2",
  },
  {
    rule: whitesOfTheirEyesRule,
    color: "white",
    fen: "4k3/8/8/8/4R3/8/8/K7 w - - 0 1",
    from: "e4",
    to: "e8",
  },
  {
    rule: indecisiveRule,
    color: "white",
    fen: "4k3/8/8/8/p3R3/8/8/K7 w - - 0 1",
    from: "e4",
    to: "e8",
  },
  {
    rule: professionalCourtesyRule,
    color: "black",
    fen: "8/8/8/8/8/8/4k3/4K3 b - - 0 1",
    from: "e2",
    to: "e1",
  },
  {
    rule: shadowQueenRule,
    color: "white",
    fen: "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    from: "e7",
    to: "e8",
  },
  {
    rule: stayAtHomeMomRule,
    color: "black",
    fen: "k7/3q4/3K4/8/8/8/8/8 b - - 0 1",
    from: "d7",
    to: "d6",
  },
  {
    rule: snipersRule,
    color: "white",
    fen: "4k3/3B4/8/8/8/8/8/K7 w - - 0 1",
    from: "d7",
    to: "e8",
  },
] as const satisfies readonly MoveCase[];

function sessionFor(
  rule: DeclarativeRule,
  color: PlayerColor,
  fen: string,
) {
  return color === "white"
    ? DrawbackGameSession.create(
        { white: rule, black: unrestrictedRule },
        new Mulberry32(0xdec1_a001),
        fen,
      )
    : DrawbackGameSession.create(
        { white: unrestrictedRule, black: rule },
        new Mulberry32(0xdec1_a002),
        fen,
      );
}

function findMove(
  moves: readonly ChessMove[],
  moveCase: Pick<MoveCase, "from" | "to" | "promotion">,
): ChessMove | undefined {
  return moves.find(
    (move) =>
      move.from === moveCase.from
      && move.to === moveCase.to
      && move.promotion === moveCase.promotion,
  );
}

function commandFor(
  moveCase: Pick<MoveCase, "from" | "to" | "promotion">,
) {
  return {
    from: moveCase.from,
    to: moveCase.to,
    ...(moveCase.promotion === undefined
      ? {}
      : { promotion: moveCase.promotion }),
  };
}

function expectAllowedTerminal(moveCase: MoveCase): void {
  const authority = CapturableKingPosition.fromFen(moveCase.fen);
  expect(authority.turn).toBe(moveCase.color);
  expect(findMove(authority.legalMoves(), moveCase)).toMatchObject({
    color: moveCase.color,
    captured: "king",
  });

  const session = sessionFor(
    moveCase.rule,
    moveCase.color,
    moveCase.fen,
  );
  expect(findMove(session.authorityLegalMoves(), moveCase)).toMatchObject({
    captured: "king",
  });
  expect(findMove(session.legalMoves(), moveCase)).toMatchObject({
    captured: "king",
  });
  expect(session.move(commandFor(moveCase))).toMatchObject({
    ok: true,
    result: {
      kind: "king-capture",
      winner: moveCase.color,
      capturedKing: moveCase.color === "white" ? "black" : "white",
      method: "direct",
    },
  });
  expect(session.authorityLegalMoves()).toEqual([]);
  expect(session.legalMoves()).toEqual([]);
}

function expectForbiddenCapture(moveCase: MoveCase): void {
  const authority = CapturableKingPosition.fromFen(moveCase.fen);
  expect(findMove(authority.legalMoves(), moveCase)).toMatchObject({
    color: moveCase.color,
    captured: "king",
  });

  const session = sessionFor(
    moveCase.rule,
    moveCase.color,
    moveCase.fen,
  );
  expect(findMove(session.authorityLegalMoves(), moveCase)).toMatchObject({
    captured: "king",
  });
  expect(findMove(session.legalMoves(), moveCase)).toBeUndefined();
  expect(session.move(commandFor(moveCase))).toMatchObject({
    ok: false,
    reason: "drawback-forbidden",
  });
  expect(session.result).toEqual({ kind: "active" });
}

describe("capturable-king declarative rules", () => {
  it("directly exposes all twelve rules as capturable-king authorities", () => {
    expect(DECLARATIVE_RULES.map(({ id }) => id)).toEqual([
      "far-sighted",
      "stop-stalling",
      "whites-of-their-eyes",
      "elephants-fear-mice",
      "control-center",
      "indecisive",
      "professional-courtesy",
      "scent-of-blood",
      "champing-at-the-bit",
      "shadow-queen",
      "stay-at-home-mom",
      "snipers",
    ]);
    for (const rule of DECLARATIVE_RULES) {
      expect(rule.supportedAuthorities).toContain("capturable-king/v1");
    }
  });

  it.each(ALLOWED_DIRECT_KING_CAPTURES)(
    "$rule.id preserves a qualifying direct king capture as terminal",
    expectAllowedTerminal,
  );

  it.each(FORBIDDEN_DIRECT_KING_CAPTURES)(
    "$rule.id filters and rejects a disqualifying direct king capture",
    expectForbiddenCapture,
  );

  it("enforces non-king restrictions for rules whose captures are universally exempt", () => {
    const elephants = sessionFor(
      elephantsFearMiceRule,
      "white",
      "7k/p7/8/8/8/8/R7/K7 w - - 0 1",
    );
    expect(findMove(elephants.authorityLegalMoves(), {
      from: "a2",
      to: "a7",
    })).toMatchObject({ piece: "rook", captured: "pawn" });
    expect(findMove(elephants.legalMoves(), {
      from: "a2",
      to: "a7",
    })).toBeUndefined();
    expect(elephants.move({ from: "a2", to: "a7" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });

    const control = sessionFor(
      controlCenterRule,
      "white",
      "7k/8/8/8/8/8/R7/K7 w - - 0 1",
    );
    expect(findMove(control.authorityLegalMoves(), {
      from: "a2",
      to: "a3",
    })).toBeDefined();
    expect(findMove(control.legalMoves(), {
      from: "a2",
      to: "a3",
    })).toBeUndefined();
    expect(control.move({ from: "a2", to: "a3" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });

    const scent = sessionFor(
      scentOfBloodRule,
      "white",
      "4k3/8/8/8/4R3/8/8/K7 w - - 0 1",
    );
    expect(findMove(scent.authorityLegalMoves(), {
      from: "e4",
      to: "e5",
    })).toBeDefined();
    expect(findMove(scent.legalMoves(), {
      from: "e4",
      to: "e5",
    })).toBeUndefined();
    expect(scent.move({ from: "e4", to: "e5" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });

    const champing = sessionFor(
      champingAtTheBitRule,
      "white",
      "7k/8/8/8/8/8/4P3/K7 w - - 0 1",
    );
    expect(findMove(champing.authorityLegalMoves(), {
      from: "e2",
      to: "e3",
    })).toBeDefined();
    expect(findMove(champing.legalMoves(), {
      from: "e2",
      to: "e3",
    })).toBeUndefined();
    expect(champing.move({ from: "e2", to: "e3" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });
  });

  it("classifies castling by the primary king endpoint", () => {
    const fen = "4k3/8/8/8/8/8/8/4K2R w K - 0 1";
    const authority = CapturableKingPosition.fromFen(fen);
    const castle = findMove(authority.legalMoves(), {
      from: "e1",
      to: "g1",
    });
    expect(castle?.flags).toContain("kingside-castle");

    const session = sessionFor(stopStallingRule, "white", fen);
    expect(findMove(session.authorityLegalMoves(), {
      from: "e1",
      to: "g1",
    })).toBeDefined();
    expect(findMove(session.legalMoves(), {
      from: "e1",
      to: "g1",
    })).toBeUndefined();
    expect(session.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });
  });

  it("applies Control Center to both real castling destinations", () => {
    const fen = "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1";
    const session = sessionFor(controlCenterRule, "white", fen);
    expect(findMove(session.authorityLegalMoves(), {
      from: "e1",
      to: "c1",
    })?.flags).toContain("queenside-castle");
    expect(findMove(session.authorityLegalMoves(), {
      from: "e1",
      to: "g1",
    })?.flags).toContain("kingside-castle");
    expect(findMove(session.legalMoves(), {
      from: "e1",
      to: "c1",
    })).toBeDefined();
    expect(findMove(session.legalMoves(), {
      from: "e1",
      to: "g1",
    })).toBeUndefined();
  });

  it("lets a local capture opportunity suppress castling for Scent of Blood", () => {
    const fen = "7k/8/8/8/8/8/3n4/R3K3 w Q - 0 1";
    const session = sessionFor(scentOfBloodRule, "white", fen);
    expect(findMove(session.authorityLegalMoves(), {
      from: "e1",
      to: "d2",
    })).toMatchObject({
      piece: "king",
      captured: "knight",
    });
    expect(findMove(session.authorityLegalMoves(), {
      from: "e1",
      to: "c1",
    })?.flags).toContain("queenside-castle");
    expect(findMove(session.legalMoves(), {
      from: "e1",
      to: "d2",
    })).toBeDefined();
    expect(findMove(session.legalMoves(), {
      from: "e1",
      to: "c1",
    })).toBeUndefined();
  });

  it("classifies ordinary en passant as an adjacent diagonal pawn capture", () => {
    const fen = "7k/8/8/6Pp/8/8/8/K7 w - h6 0 1";
    const authority = CapturableKingPosition.fromFen(fen);
    const enPassant = findMove(authority.legalMoves(), {
      from: "g5",
      to: "h6",
    });
    expect(enPassant).toMatchObject({
      piece: "pawn",
      captured: "pawn",
    });
    expect(enPassant?.flags).toContain("en-passant");

    const farSighted = sessionFor(farSightedRule, "white", fen);
    expect(findMove(farSighted.legalMoves(), {
      from: "g5",
      to: "h6",
    })).toBeUndefined();
    expect(farSighted.move({ from: "g5", to: "h6" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });

    for (const rule of [
      whitesOfTheirEyesRule,
      champingAtTheBitRule,
      stopStallingRule,
    ]) {
      const session = sessionFor(rule, "white", fen);
      expect(findMove(session.legalMoves(), {
        from: "g5",
        to: "h6",
      })).toMatchObject({
        piece: "pawn",
        captured: "pawn",
      });
      expect(session.move({ from: "g5", to: "h6" })).toMatchObject({
        ok: true,
        result: { kind: "active" },
      });
    }
  });

  it("keeps pawn identity through capture-promotion king endpoints", () => {
    const fen = "1k6/P7/8/8/8/8/8/K7 w - - 0 1";
    const promotions = CapturableKingPosition.fromFen(fen)
      .legalMoves()
      .filter((move) => move.from === "a7" && move.to === "b8");
    expect(promotions.map(({ promotion }) => promotion).sort()).toEqual([
      "bishop",
      "knight",
      "queen",
      "rook",
    ]);
    expect(promotions.every(
      (move) =>
        move.piece === "pawn"
        && move.captured === "king"
        && move.flags.includes("promotion"),
    )).toBe(true);

    for (const promotion of [
      "bishop",
      "knight",
      "queen",
      "rook",
    ] as const) {
      const session = sessionFor(champingAtTheBitRule, "white", fen);
      expect(session.move({ from: "a7", to: "b8", promotion })).toMatchObject({
        ok: true,
        result: {
          kind: "king-capture",
          winner: "white",
          method: "direct",
        },
      });
    }

    for (const rule of [shadowQueenRule, stayAtHomeMomRule]) {
      const session = sessionFor(rule, "white", fen);
      expect(session.move({
        from: "a7",
        to: "b8",
        promotion: "queen",
      })).toMatchObject({
        ok: true,
        result: { kind: "king-capture", winner: "white" },
      });
    }

    const indecisive = sessionFor(indecisiveRule, "white", fen);
    expect(indecisive.authorityLegalMoves().filter(
      (move) => move.from === "a7" && move.to === "b8",
    )).toHaveLength(4);
    expect(indecisive.legalMoves().some(
      (move) => move.from === "a7" && move.to === "b8",
    )).toBe(false);
    expect(indecisive.move({
      from: "a7",
      to: "b8",
      promotion: "queen",
    })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });
  });

  it("filters a same-type king-passant capture through Professional Courtesy", () => {
    const session = sessionFor(
      professionalCourtesyRule,
      "black",
      "8/8/8/8/8/8/5k2/4K2R w K - 0 1",
    );
    expect(session.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    const kingPassant = findMove(session.authorityLegalMoves(), {
      from: "f2",
      to: "f1",
    });
    expect(kingPassant).toMatchObject({
      piece: "king",
      captured: "king",
    });
    expect(kingPassant?.flags).toContain("king-en-passant");
    expect(findMove(session.legalMoves(), {
      from: "f2",
      to: "f1",
    })).toBeUndefined();
    expect(session.move({ from: "f2", to: "f1" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });
  });

  it("applies Snipers distance to a real castling-en-passant king capture", () => {
    const long = sessionFor(
      snipersRule,
      "black",
      "7k/8/b7/8/8/8/8/4K2R w K - 0 1",
    );
    expect(long.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    const longCapture = findMove(long.legalMoves(), {
      from: "a6",
      to: "f1",
    });
    expect(longCapture).toMatchObject({
      piece: "bishop",
      captured: "king",
    });
    expect(longCapture?.flags).toContain("king-en-passant");
    expect(long.move({ from: "a6", to: "f1" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "black",
        method: "castling-en-passant",
      },
    });

    const short = sessionFor(
      snipersRule,
      "black",
      "7k/8/8/8/8/3b4/8/4K2R w K - 0 1",
    );
    expect(short.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
      result: { kind: "active" },
    });
    const shortCapture = findMove(short.authorityLegalMoves(), {
      from: "d3",
      to: "f1",
    });
    expect(shortCapture).toMatchObject({
      piece: "bishop",
      captured: "king",
    });
    expect(shortCapture?.flags).toContain("king-en-passant");
    expect(findMove(short.legalMoves(), {
      from: "d3",
      to: "f1",
    })).toBeUndefined();
    expect(short.move({ from: "d3", to: "f1" })).toMatchObject({
      ok: false,
      reason: "drawback-forbidden",
    });
  });
});
