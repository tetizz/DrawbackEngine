import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  DrawbackRule,
  PieceType,
  PromotionPiece,
  RuleMoveContext,
} from "../types.js";
import type { PlayerColor } from "@drawbackengine/shared";
import type { NoParameters, StatelessRuleState } from "./common.js";
import {
  entrenchedRule,
  expandedRules,
  noShufflingRule,
  numberOfTheBeastRule,
  shadowQueenRule,
  stopStallingRule,
} from "./expanded-rules.js";

interface MoveInput {
  readonly from: string;
  readonly to: string;
  readonly piece: PieceType;
  readonly color?: PlayerColor;
  readonly captured?: PieceType;
  readonly promotion?: PromotionPiece;
  readonly flags?: string;
}

interface ReplayFixture {
  readonly ruleId: string;
  readonly positionFen: string;
  readonly ordinaryLegalMoves: readonly string[];
  readonly allowedMoves: readonly string[];
  readonly forbiddenMoves: readonly string[];
}

interface CatalogEntry {
  readonly id: string;
  readonly implementationStatus: string;
  readonly fixture: string;
}

function move(input: MoveInput): ChessMove {
  return {
    from: input.from,
    to: input.to,
    color: input.color ?? "white",
    piece: input.piece,
    ...(input.captured === undefined ? {} : { captured: input.captured }),
    ...(input.promotion === undefined ? {} : { promotion: input.promotion }),
    san: `${input.from}${input.to}`,
    flags: input.flags ?? (input.captured === undefined ? "quiet" : "capture"),
  };
}

function context(
  color: PlayerColor = "white",
): RuleMoveContext<StatelessRuleState, NoParameters> {
  return {
    color,
    parameters: {},
    state: { movesApplied: 0 },
    position: {
      fen: `8/8/8/8/8/8/8/8 ${color === "white" ? "w" : "b"} - - 0 1`,
      turn: color,
      ply: color === "white" ? 0 : 1,
      history: [],
    },
  };
}

const castle = move({
  from: "e1",
  to: "g1",
  piece: "king",
  flags: "quiet,kingside-castle",
});
const enPassant = move({
  from: "g5",
  to: "h6",
  piece: "pawn",
  captured: "pawn",
  flags: "capture,en-passant",
});
const promotion = move({
  from: "a7",
  to: "a8",
  piece: "pawn",
  promotion: "queen",
  flags: "quiet,promotion",
});

describe("expanded rule metadata and families", () => {
  it("keeps the bounded batch implemented-unverified and unparameterized", () => {
    expect(expandedRules).toHaveLength(5);
    expect(expandedRules.map((rule) => rule.verification)).toEqual(
      Array.from({ length: 5 }, () => "implemented-unverified"),
    );
    for (const rule of expandedRules) {
      expect(rule.generateParameters({
        next: () => 0,
        integer: () => 0,
      })).toEqual({});
      expect(rule.checkStartOfTurnLoss(context())).toBeNull();
    }
  });

  it("returns new filtered arrays without mutating ordinary legal moves", () => {
    const moves = Object.freeze([
      move({ from: "g5", to: "g6", piece: "pawn" }),
      move({ from: "g5", to: "g4", piece: "pawn" }),
    ]);
    const before = [...moves];
    const filtered = numberOfTheBeastRule.filterLegalMoves(context(), moves);
    expect(filtered).not.toBe(moves);
    expect(moves).toEqual(before);
  });
});

describe("Number of the Beast", () => {
  it("forbids absolute rank six for both colors and for captures", () => {
    const whiteToSix = move({ from: "g5", to: "g6", piece: "pawn" });
    const blackToSix = move({
      from: "g7",
      to: "g6",
      piece: "pawn",
      color: "black",
      captured: "knight",
    });
    const blackAway = move({
      from: "g6",
      to: "g5",
      piece: "pawn",
      color: "black",
    });
    expect(numberOfTheBeastRule.filterLegalMoves(context(), [whiteToSix]))
      .toEqual([]);
    expect(numberOfTheBeastRule.filterLegalMoves(
      context("black"),
      [blackToSix, blackAway],
    )).toEqual([blackAway]);
  });

  it("forbids en-passant landing on rank six but permits castling and promotion", () => {
    expect(numberOfTheBeastRule.filterLegalMoves(
      context(),
      [enPassant, castle, promotion],
    )).toEqual([castle, promotion]);
  });
});

describe("Shadow Queen", () => {
  it("permits queen moves to dark squares and rejects light destinations", () => {
    const dark = move({ from: "d1", to: "d2", piece: "queen" });
    const light = move({
      from: "d1",
      to: "d3",
      piece: "queen",
      captured: "rook",
    });
    expect(shadowQueenRule.filterLegalMoves(context(), [dark, light]))
      .toEqual([dark]);
  });

  it("classifies a promotion by its pawn mover and leaves other specials alone", () => {
    expect(shadowQueenRule.filterLegalMoves(
      context(),
      [promotion, enPassant, castle],
    )).toEqual([promotion, enPassant, castle]);
  });
});

describe("Entrenched", () => {
  it("allows rook travel of at most two squares, including captures", () => {
    const one = move({ from: "a1", to: "a2", piece: "rook" });
    const two = move({
      from: "a1",
      to: "a3",
      piece: "rook",
      captured: "pawn",
    });
    const three = move({ from: "a1", to: "a4", piece: "rook" });
    expect(entrenchedRule.filterLegalMoves(context(), [one, two, three]))
      .toEqual([one, two]);
  });

  it("does not classify castling or promotion-to-rook as a rook move", () => {
    const rookPromotion = { ...promotion, promotion: "rook" as const };
    expect(entrenchedRule.filterLegalMoves(
      context(),
      [castle, rookPromotion],
    )).toEqual([castle, rookPromotion]);
  });
});

describe("No Shuffling and Stop Stalling", () => {
  const rookVertical = move({
    from: "a1",
    to: "a3",
    piece: "rook",
    captured: "pawn",
  });
  const rookLateral = move({
    from: "a1",
    to: "c1",
    piece: "rook",
    captured: "bishop",
  });

  it("No Shuffling restricts only lateral rook moves", () => {
    const queenLateral = move({ from: "d1", to: "f1", piece: "queen" });
    expect(noShufflingRule.filterLegalMoves(
      context(),
      [rookVertical, rookLateral, queenLateral, castle],
    )).toEqual([rookVertical, queenLateral, castle]);
  });

  it("Stop Stalling rejects lateral primary moves including castling", () => {
    const diagonal = move({ from: "e1", to: "d2", piece: "king" });
    expect(stopStallingRule.filterLegalMoves(
      context(),
      [rookVertical, rookLateral, diagonal, enPassant, promotion, castle],
    )).toEqual([rookVertical, diagonal, enPassant, promotion]);
  });
});

describe("edge validation and explanations", () => {
  it("fails closed on malformed squares", () => {
    const invalid = move({ from: "a1", to: "z9", piece: "rook" });
    expect(() =>
      entrenchedRule.filterLegalMoves(context(), [invalid])
    ).toThrowError("Invalid chess square");
  });

  it("explains a rejected move with rule identity", () => {
    const forbidden = move({ from: "a1", to: "a4", piece: "rook" });
    expect(entrenchedRule.explainMove?.(context(), forbidden)).toEqual([
      expect.objectContaining({
        ruleId: "entrenched",
        kind: "eliminated",
        move: forbidden,
      }),
    ]);
  });
});

describe("catalog replay fixtures", () => {
  const pieces: Readonly<Record<string, PieceType>> = {
    a1: "rook",
    d1: "queen",
    e1: "king",
    g1: "knight",
    g4: "pawn",
    g5: "pawn",
  };
  const byId = new Map<string, DrawbackRule<StatelessRuleState, NoParameters>>(
    expandedRules.map((rule) => [rule.id, rule]),
  );
  const fixtures = expandedRules.map((rule) => {
    const url = new URL(
      `../../../../docs/rules/expanded/replays/${rule.id}.json`,
      import.meta.url,
    );
    return JSON.parse(readFileSync(url, "utf8")) as ReplayFixture;
  });
  const catalog = JSON.parse(
    readFileSync(
      new URL("../../../../data/catalog/expanded-drawbacks.json", import.meta.url),
      "utf8",
    ),
  ) as readonly CatalogEntry[];

  it("keeps catalog IDs, status, and replay pointers aligned", () => {
    expect(catalog.map(({ id }) => id)).toEqual(
      expandedRules.map(({ id }) => id),
    );
    expect(catalog.every(
      ({ implementationStatus }) =>
        implementationStatus === "implemented-unverified",
    )).toBe(true);
    expect(catalog.map(({ fixture }) => fixture)).toEqual(
      expandedRules.map(
        ({ id }) => `docs/rules/expanded/replays/${id}.json`,
      ),
    );
  });

  it.each(fixtures)("$ruleId replay filters the documented ordinary moves", (fixture) => {
    const rule = byId.get(fixture.ruleId);
    expect(rule).toBeDefined();
    expect(fixture.positionFen).toMatch(/ [wb] /);
    const ordinary = fixture.ordinaryLegalMoves.map((uci) =>
      move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        piece: pieces[uci.slice(0, 2)] ?? "pawn",
      }),
    );
    expect(
      rule?.filterLegalMoves(context(), ordinary).map(({ from, to }) => from + to),
    ).toEqual(fixture.allowedMoves);
    expect(new Set([
      ...fixture.allowedMoves,
      ...fixture.forbiddenMoves,
    ])).toEqual(new Set(fixture.ordinaryLegalMoves));
  });
});
