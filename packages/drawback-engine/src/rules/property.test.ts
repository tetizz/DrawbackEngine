import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  DrawbackRule,
  PieceType,
  RuleMoveContext,
} from "../types.js";
import {
  checkersRule,
  lameDuckRule,
  spiceOfLifeRule,
  truantRule,
  veganRule,
} from "./index.js";

const pieces: readonly PieceType[] = [
  "pawn",
  "knight",
  "bishop",
  "rook",
  "queen",
  "king",
];

function generatedMoves(): readonly ChessMove[] {
  return Object.freeze(
    pieces.flatMap((piece, index) => [
      Object.freeze({
        from: `${String.fromCharCode(97 + index)}2`,
        to: `${String.fromCharCode(97 + index)}3`,
        color: "white" as const,
        piece,
        san: `${piece}-${String(index)}`,
        flags: "quiet",
      }),
      Object.freeze({
        from: `${String.fromCharCode(97 + index)}4`,
        to: `${String.fromCharCode(98 + index)}5`,
        color: "white" as const,
        piece,
        captured: pieces[(index + 1) % pieces.length] ?? "pawn",
        san: `${piece}x${String(index)}`,
        flags: "capture",
      }),
    ]),
  );
}

const position = {
  fen: "bounded-property-position",
  turn: "white" as const,
  ply: 12,
  history: [] as const,
};

function assertImmutableFilter<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
  context: RuleMoveContext<State, Parameters>,
): void {
  const input = generatedMoves();
  const snapshot = input.map((move) => ({ ...move }));
  const output = rule.filterLegalMoves(context, input);

  expect(input).toEqual(snapshot);
  expect(output).not.toBe(input);
  expect(output.every((move) => input.includes(move))).toBe(true);
}

describe("drawback filter bounded properties", () => {
  it("does not mutate its ordinary legal input and only removes moves", () => {
    assertImmutableFilter(veganRule, {
      color: "white",
      parameters: {},
      state: { movesApplied: 3 },
      position,
    });
    assertImmutableFilter(lameDuckRule, {
      color: "white",
      parameters: {},
      state: { movesApplied: 3 },
      position,
    });
    assertImmutableFilter(checkersRule, {
      color: "white",
      parameters: {},
      state: { movesApplied: 3 },
      position,
    });
    assertImmutableFilter(truantRule, {
      color: "white",
      parameters: {},
      state: { previousMoverDestination: "a2" },
      position,
    });
    assertImmutableFilter(spiceOfLifeRule, {
      color: "white",
      parameters: {},
      state: { previousMoverType: "knight" },
      position,
    });
  });
});
