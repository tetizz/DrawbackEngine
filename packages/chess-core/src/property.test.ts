import { describe, expect, it } from "vitest";
import {
  type DrawbackRule,
  executableRules,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { GameSession, type MoveCommand } from "./index.js";

function key(move: { readonly from: string; readonly to: string; readonly promotion?: string }) {
  return `${move.from}:${move.to}:${move.promotion ?? ""}`;
}

function assertStandardSubset<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
  ruleIndex: number,
): void {
  const session = new GameSession(
    { white: rule, black: rule },
    new Mulberry32(0x51eed + ruleIndex),
  );
  const selector = new Mulberry32(0xc0ffee + ruleIndex);

  for (let ply = 0; ply < 32 && session.result.kind === "active"; ply += 1) {
    const ordinary = new Set(session.ordinaryLegalMoves().map(key));
    const drawbackLegal = session.legalMoves();
    expect(
      drawbackLegal.every((move) => ordinary.has(key(move))),
      `${rule.id} emitted a non-standard move at ply ${String(ply)}`,
    ).toBe(true);

    const selected = drawbackLegal[selector.integer(drawbackLegal.length)];
    expect(selected).toBeDefined();
    const command: MoveCommand = {
      from: selected?.from ?? "",
      to: selected?.to ?? "",
      ...(selected?.promotion === undefined
        ? {}
        : { promotion: selected.promotion }),
    };
    expect(session.move(command).ok).toBe(true);
  }
}

describe("GameSession bounded properties", () => {
  it(
    "returns only ordinary chess-legal moves for every executable rule",
    () => {
      executableRules.forEach(assertStandardSubset);
    },
    90_000,
  );
});
