import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  DrawbackRule,
  RuleLossContext,
} from "../types.js";
import type { PlayerColor } from "@drawbackengine/shared";
import type { NoParameters, StatelessRuleState } from "./common.js";
import {
  abstinenceRule,
  alwaysCheckRule,
  boastfulRule,
  closedBookRule,
  holdThemBackRule,
  homelandSecurityRule,
  ivoryTowerRule,
  kingOfTheHillRule,
  lossRules,
  modestRule,
  simpRule,
  towerDefenseRule,
  warlordRule,
} from "./loss-rules.js";

function context(
  fen: string,
  color: PlayerColor = "white",
  history: readonly ChessMove[] = [],
): RuleLossContext<StatelessRuleState, NoParameters> {
  return {
    color,
    parameters: {},
    state: { movesApplied: history.filter((move) => move.color === color).length },
    position: {
      fen,
      turn: color,
      ply: history.length,
      history,
    },
  };
}

function loses(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
  fen: string,
  color: PlayerColor = "white",
  history: readonly ChessMove[] = [],
): boolean {
  return rule.checkStartOfTurnLoss(context(fen, color, history)) !== null;
}

function quiet(color: PlayerColor, from: string, to: string): ChessMove {
  return {
    color,
    from,
    to,
    piece: "pawn",
    san: from + to,
    flags: "quiet",
  };
}

describe("loss rule catalog", () => {
  it("registers twelve executable but unverified loss rules", () => {
    expect(lossRules).toHaveLength(12);
    expect(new Set(lossRules.map(({ id }) => id)).size).toBe(12);
    expect(lossRules.every(
      ({ verification }) => verification === "implemented-unverified",
    )).toBe(true);
  });

  it("matches the machine-readable loss catalog", () => {
    const catalog = JSON.parse(readFileSync(
      new URL("../../../../data/catalog/loss-drawbacks.json", import.meta.url),
      "utf8",
    )) as readonly {
      readonly id: string;
      readonly implementationStatus: string;
    }[];
    expect(catalog.map(({ id }) => id).sort()).toEqual(
      lossRules.map(({ id }) => id).sort(),
    );
    expect(catalog.every(
      ({ implementationStatus }) =>
        implementationStatus === "implemented-unverified",
    )).toBe(true);
  });
});

describe("direct board loss predicates", () => {
  it("Abstinence includes orthogonal and diagonal adjacency but excludes pawns", () => {
    expect(loses(abstinenceRule, "rr2k3/8/8/8/8/8/8/4K3 w - - 0 1"))
      .toBe(true);
    expect(loses(abstinenceRule, "r3k3/1r6/8/8/8/8/8/4K3 w - - 0 1"))
      .toBe(true);
    expect(loses(abstinenceRule, "pp2k3/8/8/8/8/8/8/4K3 w - - 0 1"))
      .toBe(false);
  });

  it("Always Check detects check for either color", () => {
    expect(loses(
      alwaysCheckRule,
      "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1",
    )).toBe(true);
    expect(loses(
      alwaysCheckRule,
      "4k3/4R3/8/8/8/8/8/4K3 b - - 0 1",
      "black",
    )).toBe(true);
  });

  it("Boastful and Modest use strict all-piece counts", () => {
    const blackAhead = "4k3/8/8/8/8/8/p7/4K3 w - - 0 1";
    expect(loses(boastfulRule, blackAhead)).toBe(true);
    expect(loses(modestRule, blackAhead)).toBe(false);
    expect(loses(modestRule, blackAhead.replace("p7", "P7"))).toBe(true);
  });

  it("Closed Book loses when any file has no pawn", () => {
    expect(loses(
      closedBookRule,
      "4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1",
    )).toBe(false);
    expect(loses(
      closedBookRule,
      "4k3/1ppppppp/8/8/8/8/1PPPPPPP/4K3 w - - 0 1",
    )).toBe(true);
  });

  it("Hold Them Back uses the affected player's board half", () => {
    expect(loses(
      holdThemBackRule,
      "4k3/8/8/8/3p4/8/8/4K3 w - - 0 1",
    )).toBe(true);
    expect(loses(
      holdThemBackRule,
      "4k3/8/8/4P3/8/8/8/4K3 b - - 0 1",
      "black",
    )).toBe(true);
  });

  it("Homeland Security checks the two color-relative home ranks", () => {
    expect(loses(
      homelandSecurityRule,
      "4k3/8/8/8/8/8/r7/4K3 w - - 0 1",
    )).toBe(true);
    expect(loses(
      homelandSecurityRule,
      "4k3/R7/8/8/8/8/8/4K3 b - - 0 1",
      "black",
    )).toBe(true);
  });

  it("Ivory Tower uses physical adjacency rather than attack legality", () => {
    expect(loses(
      ivoryTowerRule,
      "4k3/8/8/8/8/8/3n4/4K3 w - - 0 1",
    )).toBe(true);
    expect(loses(
      ivoryTowerRule,
      "4k3/8/8/8/8/3n4/8/4K3 w - - 0 1",
    )).toBe(false);
  });

  it("Simp and Tower Defense count promoted pieces by current board type", () => {
    expect(loses(simpRule, "4k3/8/8/8/8/8/8/3QK3 w - - 0 1"))
      .toBe(false);
    expect(loses(simpRule, "4k3/8/8/8/8/8/8/4K3 w - - 0 1"))
      .toBe(true);
    expect(loses(towerDefenseRule, "4k3/8/8/8/8/8/8/R3K3 w - - 0 1"))
      .toBe(false);
    expect(loses(towerDefenseRule, "4k3/8/8/8/8/8/8/4K3 w - - 0 1"))
      .toBe(true);
  });
});

describe("history-aware loss predicates", () => {
  it("King of the Hill exempts only the affected player's first turn", () => {
    const fen = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";
    expect(loses(kingOfTheHillRule, fen)).toBe(false);
    expect(loses(kingOfTheHillRule, fen, "white", [
      quiet("white", "a2", "a3"),
      quiet("black", "a7", "a6"),
    ])).toBe(true);
    expect(loses(
      kingOfTheHillRule,
      "4k3/8/8/8/3P4/8/8/4K3 w - - 0 1",
      "white",
      [quiet("white", "d2", "d4")],
    )).toBe(false);
  });

  it("Warlord triggers on the twelfth color-relative turn", () => {
    const history = Array.from({ length: 21 }, (_, index) =>
      quiet(index % 2 === 0 ? "white" : "black", "a2", "a3"));
    const home = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";
    expect(loses(warlordRule, home, "white", history.slice(0, 20))).toBe(false);
    expect(loses(warlordRule, home, "white", history)).toBe(true);
    expect(loses(
      warlordRule,
      "4k3/8/8/8/4K3/8/8/8 w - - 0 1",
      "white",
      history,
    )).toBe(false);
  });

  it("Tower Defense forbids rook movers before the loss condition", () => {
    const moves = [
      { ...quiet("white", "a1", "a2"), piece: "rook" as const },
      quiet("white", "b2", "b3"),
    ];
    expect(towerDefenseRule.filterLegalMoves(
      context("4k3/8/8/8/8/8/1P6/R3K3 w - - 0 1"),
      moves,
    )).toEqual([moves[1]]);
  });
});
