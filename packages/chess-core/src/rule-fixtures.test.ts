import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import {
  resolveExecutableRule,
  type ChessMove,
} from "@drawbackengine/drawback-engine";
import { playerColor, toChessMove } from "./move-adapter.js";

interface RuleFixture {
  readonly ruleId: string;
  readonly contextOnly?: boolean;
  readonly positionFen?: string;
  readonly ordinaryLegalMoves?: readonly string[];
  readonly allowedMoves?: readonly string[];
  readonly forbiddenMoves?: readonly string[];
  readonly initialState?: unknown;
  readonly lossExpected?: boolean;
  readonly historyByColor?: Readonly<Partial<Record<"white" | "black", number>>>;
  readonly history?: readonly ChessMove[];
  readonly parameters?: unknown;
}

function fixturePaths(root: string): readonly string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory()
      ? fixturePaths(path)
      : entry.endsWith(".json")
        ? [path]
        : [];
  });
}

function moveKey(move: {
  readonly from: string;
  readonly to: string;
  readonly promotion?: string;
}): string {
  const promotionSymbols: Readonly<Record<string, string>> = {
    knight: "n",
    bishop: "b",
    rook: "r",
    queen: "q",
  };
  const promotion = move.promotion === undefined
    ? ""
    : promotionSymbols[move.promotion] ?? move.promotion;
  return `${move.from}${move.to}${promotion}`;
}

describe("rule replay fixtures", () => {
  it("contains only standard-chess legal moves for each declared position", () => {
    const root = fileURLToPath(new URL(
      "../../../data/fixtures/rules/",
      import.meta.url,
    ));
    for (const path of fixturePaths(root)) {
      const fixture = JSON.parse(readFileSync(path, "utf8")) as RuleFixture;
      if (
        fixture.positionFen === undefined ||
        fixture.ordinaryLegalMoves === undefined
      ) {
        continue;
      }
      const chess = new Chess(fixture.positionFen);
      const legal = new Set(chess.moves({ verbose: true }).map(moveKey));
      for (const move of fixture.ordinaryLegalMoves) {
        expect(
          legal.has(move),
          `${basename(path)} declares illegal ordinary move ${move}`,
        ).toBe(true);
      }
    }
  });

  it("applies reviewed move labels through the executable rule context", () => {
    const roots = [
      "community-two",
      "observed-three",
      "board-relative",
      "history-filter",
      "parameterized-four",
      "observed-five",
      "observed-six",
      "observed-seven",
      "observed-eight",
      "observed-nine",
      "observed-ten",
      "observed-eleven",
    ].map((directory) =>
      fileURLToPath(new URL(
        `../../../data/fixtures/rules/${directory}/`,
        import.meta.url,
      )));
    for (const path of roots.flatMap(fixturePaths)) {
      const fixture = JSON.parse(readFileSync(path, "utf8")) as RuleFixture;
      if (
        fixture.positionFen === undefined ||
        fixture.allowedMoves === undefined ||
        fixture.forbiddenMoves === undefined
      ) {
        throw new Error(`${basename(path)} is missing replay fields.`);
      }
      const chess = new Chess(fixture.positionFen);
      const color = playerColor(chess.turn());
      const ordinary = chess.moves({ verbose: true }).map(toChessMove);
      const history = fixture.history ?? [];
      const position = {
        fen: chess.fen(),
        turn: color,
        ply: history.length,
        history,
      } as const;
      const rule = resolveExecutableRule(fixture.ruleId);
      const parameters = fixture.parameters ?? {};
      const state = (
        fixture.initialState ?? rule.initialize({
          color,
          parameters,
          position,
        })
      ) as Readonly<unknown>;
      const allowed = new Set(
        rule.filterLegalMoves(
          { color, parameters, state, position },
          ordinary,
        ).map(moveKey),
      );
      for (const move of fixture.allowedMoves) {
        expect(
          allowed.has(move),
          `${basename(path)} expected ${move} to be drawback-legal`,
        ).toBe(true);
      }
      for (const move of fixture.forbiddenMoves) {
        expect(
          allowed.has(move),
          `${basename(path)} expected ${move} to be drawback-forbidden`,
        ).toBe(false);
      }
    }
  });

  it("replays start-of-turn loss fixtures through the executable rule", () => {
    const root = fileURLToPath(new URL(
      "../../../data/fixtures/rules/loss/",
      import.meta.url,
    ));
    for (const path of fixturePaths(root)) {
      const fixture = JSON.parse(readFileSync(path, "utf8")) as RuleFixture;
      if (
        fixture.positionFen === undefined ||
        fixture.lossExpected === undefined
      ) {
        throw new Error(`${basename(path)} is missing loss replay fields.`);
      }
      const chess = new Chess(fixture.positionFen);
      const color = playerColor(chess.turn());
      const history = fixture.history ?? (
        ["white", "black"] as const
      ).flatMap((moveColor) =>
        Array.from(
          { length: fixture.historyByColor?.[moveColor] ?? 0 },
          (_, index) => ({
            from: "a2",
            to: "a3",
            color: moveColor,
            piece: "pawn" as const,
            san: `fixture-${moveColor}-${String(index)}`,
            flags: "quiet",
          }),
        ));
      const position = {
        fen: chess.fen(),
        turn: color,
        ply: history.length,
        history,
      } as const;
      const rule = resolveExecutableRule(fixture.ruleId);
      const parameters = {};
      const state = rule.initialize({
        color,
        parameters,
        position,
      }) as Readonly<unknown>;
      expect(
        rule.checkStartOfTurnLoss({ color, parameters, state, position }) !==
          null,
        `${basename(path)} loss expectation`,
      ).toBe(fixture.lossExpected);
    }
  });
});
