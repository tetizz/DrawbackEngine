import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveExecutableRule,
  unrestrictedRule,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { GameSession, type MoveCommand } from "./game-session.js";

interface InitialRuleReplay {
  readonly ruleId: string;
  readonly initialFen: string;
  readonly moves: readonly string[];
  readonly allowedProbe?: string;
  readonly requiredMove?: string;
  readonly forbiddenProbe?: string;
  readonly forbiddenProbes?: readonly string[];
}

const RULE_IDS = [
  "vegan",
  "lame-duck",
  "checkers",
  "truant",
  "spice-of-life",
] as const;

function command(uci: string): MoveCommand {
  const promotion = {
    n: "knight",
    b: "bishop",
    r: "rook",
    q: "queen",
  } as const;
  const symbol = uci[4] as keyof typeof promotion | undefined;
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(symbol === undefined ? {} : { promotion: promotion[symbol] }),
  };
}

function fixture(ruleId: string): InitialRuleReplay {
  const path = fileURLToPath(new URL(
    `../../../data/fixtures/rules/${ruleId}.json`,
    import.meta.url,
  ));
  return JSON.parse(readFileSync(path, "utf8")) as InitialRuleReplay;
}

function createSession(replay: InitialRuleReplay) {
  return new GameSession(
    {
      white: resolveExecutableRule(replay.ruleId),
      black: unrestrictedRule,
    },
    new Mulberry32(1),
    replay.initialFen,
  );
}

describe("initial rule replay fixtures", () => {
  for (const ruleId of RULE_IDS) {
    it(`replays ${ruleId} and exercises its declared probes`, () => {
      const replay = fixture(ruleId);
      expect(replay.ruleId).toBe(ruleId);
      const session = createSession(replay);

      for (const uci of replay.moves) {
        const outcome = session.move(command(uci));
        expect(outcome.ok, `${ruleId} replay move ${uci}`).toBe(true);
      }

      const legal = new Set(
        session.legalMoves().map((move) =>
          `${move.from}${move.to}${move.promotion?.[0] ?? ""}`),
      );
      const ordinary = new Set(
        session.ordinaryLegalMoves().map((move) =>
          `${move.from}${move.to}${move.promotion?.[0] ?? ""}`),
      );
      for (const uci of [replay.allowedProbe, replay.requiredMove]) {
        if (uci !== undefined) {
          expect(ordinary.has(uci), `${ruleId} probe ${uci} is standard-legal`).toBe(true);
          expect(legal.has(uci), `${ruleId} allows ${uci}`).toBe(true);
        }
      }
      for (const uci of [
        replay.forbiddenProbe,
        ...(replay.forbiddenProbes ?? []),
      ]) {
        if (uci !== undefined) {
          expect(ordinary.has(uci), `${ruleId} probe ${uci} is standard-legal`).toBe(true);
          expect(legal.has(uci), `${ruleId} forbids ${uci}`).toBe(false);
        }
      }
    });
  }
});
