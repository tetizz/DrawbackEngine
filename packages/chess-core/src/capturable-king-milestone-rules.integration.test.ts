import { describe, expect, it } from "vitest";
import {
  AUDITED_CAPTURABLE_KING_RULE_IDS,
  resolveAuditedCapturableKingRule,
  unrestrictedRule,
  type AuditedCapturableKingRuleId,
  type ChessMove,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { DrawbackGameSession } from "./drawback-game-session.js";

const MILESTONE_RULE_IDS = [
  "vegan",
  "true-gentleman",
  "false-prophets",
  "trophy-wife",
  "lame-duck",
  "cess",
  "forward-march",
  "checkers",
  "pacman",
  "oddball",
  "even-keeled",
  "truant",
  "spice-of-life",
  "quit-horsing-around",
  "remorseful",
  "battle-fatigue",
  "eye-for-an-eye",
  "barbarian-rage",
  "conscientious-objectors",
  "horse-tranquilizer",
] as const satisfies readonly AuditedCapturableKingRuleId[];

function whiteSession(
  ruleId: AuditedCapturableKingRuleId,
  fen: string,
) {
  return DrawbackGameSession.create(
    {
      white: resolveAuditedCapturableKingRule(ruleId),
      black: unrestrictedRule,
    },
    new Mulberry32(0x25ca_7e01),
    fen,
  );
}

function blackSession(
  ruleId: AuditedCapturableKingRuleId,
  fen: string,
) {
  return DrawbackGameSession.create(
    {
      white: unrestrictedRule,
      black: resolveAuditedCapturableKingRule(ruleId),
    },
    new Mulberry32(0x25ca_7e02),
    fen,
  );
}

function hasMove(
  moves: readonly ChessMove[],
  from: string,
  to: string,
): boolean {
  return moves.some((move) => move.from === from && move.to === to);
}

function expectFiltered(
  ruleId: AuditedCapturableKingRuleId,
  fen: string,
  forbidden: readonly [from: string, to: string],
  allowed: readonly [from: string, to: string],
): void {
  const session = whiteSession(ruleId, fen);
  expect(
    hasMove(session.authorityLegalMoves(), ...forbidden),
    `${ruleId} authority setup is missing ${forbidden.join("")}`,
  ).toBe(true);
  expect(
    hasMove(session.authorityLegalMoves(), ...allowed),
    `${ruleId} authority setup is missing ${allowed.join("")}`,
  ).toBe(true);
  expect(
    hasMove(session.legalMoves(), ...forbidden),
    `${ruleId} admitted forbidden ${forbidden.join("")}`,
  ).toBe(false);
  expect(
    hasMove(session.legalMoves(), ...allowed),
    `${ruleId} removed allowed ${allowed.join("")}`,
  ).toBe(true);
}

describe("capturable-king initial milestone rules", () => {
  it("exposes every first-milestone rule through the audited authority catalog", () => {
    expect(AUDITED_CAPTURABLE_KING_RULE_IDS).toEqual(
      expect.arrayContaining([...MILESTONE_RULE_IDS]),
    );
    for (const ruleId of MILESTONE_RULE_IDS) {
      expect(
        resolveAuditedCapturableKingRule(ruleId).supportedAuthorities,
      ).toContain("capturable-king/v1");
    }
  });

  it.each([
    {
      ruleId: "true-gentleman" as const,
      fen: "4q2k/4R3/8/8/8/8/8/K7 w - - 0 1",
      forbidden: ["e7", "e8"] as const,
      allowed: ["e7", "e6"] as const,
    },
    {
      ruleId: "false-prophets" as const,
      fen: "4k3/3B4/8/8/8/8/8/K7 w - - 0 1",
      forbidden: ["d7", "e8"] as const,
      allowed: ["d7", "c8"] as const,
    },
    {
      ruleId: "trophy-wife" as const,
      fen: "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
      forbidden: ["e7", "e8"] as const,
      allowed: ["e7", "d7"] as const,
    },
    {
      ruleId: "cess" as const,
      fen: "7k/7R/8/8/8/8/8/K7 w - - 0 1",
      forbidden: ["h7", "h8"] as const,
      allowed: ["h7", "g7"] as const,
    },
    {
      ruleId: "forward-march" as const,
      fen: "8/4R3/4k3/8/8/8/8/K7 w - - 0 1",
      forbidden: ["e7", "e6"] as const,
      allowed: ["e7", "e8"] as const,
    },
    {
      ruleId: "pacman" as const,
      fen: "4k3/4R3/8/3p4/2B5/8/8/K7 w - - 0 1",
      forbidden: ["e7", "e8"] as const,
      allowed: ["c4", "d5"] as const,
    },
    {
      ruleId: "oddball" as const,
      fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 2",
      forbidden: ["e7", "e8"] as const,
      allowed: ["e7", "e6"] as const,
    },
    {
      ruleId: "even-keeled" as const,
      fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
      forbidden: ["e7", "e8"] as const,
      allowed: ["e7", "e6"] as const,
    },
    {
      ruleId: "horse-tranquilizer" as const,
      fen: "4k3/8/5N2/8/8/8/8/K7 w - - 0 1",
      forbidden: ["f6", "e8"] as const,
      allowed: ["f6", "h7"] as const,
    },
  ])("enforces $ruleId against authority-generated terminal moves", ({
    ruleId,
    fen,
    forbidden,
    allowed,
  }) => {
    expectFiltered(ruleId, fen, forbidden, allowed);
  });

  it("treats every promotion form of a pawn king-capture as a capture", () => {
    const session = whiteSession(
      "conscientious-objectors",
      "1k6/P7/8/8/8/8/8/K7 w - - 0 1",
    );
    const authorityCaptures = session.authorityLegalMoves().filter(
      (move) => move.from === "a7" && move.to === "b8",
    );
    expect(authorityCaptures.map((move) => move.promotion).sort()).toEqual([
      "bishop",
      "knight",
      "queen",
      "rook",
    ]);
    expect(
      session.legalMoves().some(
        (move) => move.from === "a7" && move.to === "b8",
      ),
    ).toBe(false);
  });

  it.each([
    {
      ruleId: "true-gentleman" as const,
      fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
      from: "e7",
      to: "e8",
    },
    {
      ruleId: "cess" as const,
      fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
      from: "e7",
      to: "e8",
    },
    {
      ruleId: "forward-march" as const,
      fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
      from: "e7",
      to: "e8",
    },
    {
      ruleId: "pacman" as const,
      fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
      from: "e7",
      to: "e8",
    },
    {
      ruleId: "oddball" as const,
      fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
      from: "e7",
      to: "e8",
    },
    {
      ruleId: "even-keeled" as const,
      fen: "4k3/4R3/8/8/8/8/8/K7 w - - 0 2",
      from: "e7",
      to: "e8",
    },
  ])("allows $ruleId to finish with a qualifying king capture", ({
    ruleId,
    fen,
    from,
    to,
  }) => {
    const session = whiteSession(ruleId, fen);
    expect(session.move({ from, to })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
        capturedKing: "black",
      },
    });
  });

  it("applies Trophy Wife and False Prophets to castling-en-passant king capture", () => {
    const trophy = blackSession(
      "trophy-wife",
      "5q1k/8/8/8/8/8/8/4K2R w K - 0 1",
    );
    expect(trophy.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
    });
    expect(trophy.authorityLegalMoves()).toContainEqual(
      expect.objectContaining({
        from: "f8",
        to: "f1",
        piece: "queen",
        captured: "king",
      }),
    );
    expect(hasMove(trophy.legalMoves(), "f8", "f1")).toBe(false);

    const prophets = blackSession(
      "false-prophets",
      "7k/8/b7/8/8/8/8/4K2R w K - 0 1",
    );
    expect(prophets.move({ from: "e1", to: "g1" })).toMatchObject({
      ok: true,
    });
    expect(prophets.authorityLegalMoves()).toContainEqual(
      expect.objectContaining({
        from: "a6",
        to: "f1",
        piece: "bishop",
        captured: "king",
      }),
    );
    expect(hasMove(prophets.legalMoves(), "a6", "f1")).toBe(false);
  });

  it("retains Quit Horsing Around state across the opponent reply", () => {
    const session = whiteSession(
      "quit-horsing-around",
      "4k3/7p/5N2/8/8/N7/8/K7 w - - 0 1",
    );
    expect(session.move({ from: "a3", to: "b5" })).toMatchObject({
      ok: true,
    });
    expect(session.move({ from: "h7", to: "h6" })).toMatchObject({
      ok: true,
    });
    expect(hasMove(session.authorityLegalMoves(), "f6", "e8")).toBe(true);
    expect(hasMove(session.legalMoves(), "f6", "e8")).toBe(false);
  });

  it("makes a prior capture block Remorseful's otherwise terminal reply", () => {
    const session = whiteSession(
      "remorseful",
      "4k3/p3Q2p/8/8/8/8/8/RK6 w - - 0 1",
    );
    expect(session.move({ from: "a1", to: "a7" })).toMatchObject({
      ok: true,
    });
    expect(session.move({ from: "h7", to: "h6" })).toMatchObject({
      ok: true,
    });
    expect(hasMove(session.authorityLegalMoves(), "e7", "e8")).toBe(true);
    expect(hasMove(session.legalMoves(), "e7", "e8")).toBe(false);
  });

  it("tracks a fatigued piece across a capture and opponent reply", () => {
    const session = whiteSession(
      "battle-fatigue",
      "4k3/7p/4p3/8/8/8/8/K3R3 w - - 0 1",
    );
    expect(session.move({ from: "e1", to: "e6" })).toMatchObject({
      ok: true,
    });
    expect(session.move({ from: "h7", to: "h6" })).toMatchObject({
      ok: true,
    });
    expect(hasMove(session.authorityLegalMoves(), "e6", "e8")).toBe(true);
    expect(hasMove(session.legalMoves(), "e6", "e8")).toBe(false);
  });

  it("lets a king capture satisfy Eye for an Eye's forced response", () => {
    const session = whiteSession(
      "eye-for-an-eye",
      "r3k3/4Q3/8/8/8/8/8/RK6 b - - 0 1",
    );
    expect(session.move({ from: "a8", to: "a1" })).toMatchObject({
      ok: true,
    });
    expect(session.legalMoves().every((move) => move.captured !== undefined))
      .toBe(true);
    expect(session.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
      },
    });
  });

  it("lets a king capture satisfy Barbarian Rage while suppressing quiet moves", () => {
    const session = whiteSession(
      "barbarian-rage",
      "4k3/p3Q2p/8/8/8/8/8/RK6 w - - 0 1",
    );
    expect(session.move({ from: "a1", to: "a7" })).toMatchObject({
      ok: true,
    });
    expect(session.move({ from: "h7", to: "h6" })).toMatchObject({
      ok: true,
    });
    expect(hasMove(session.legalMoves(), "a7", "a8")).toBe(false);
    expect(session.move({ from: "e7", to: "e8" })).toMatchObject({
      ok: true,
      result: {
        kind: "king-capture",
        winner: "white",
      },
    });
  });
});
