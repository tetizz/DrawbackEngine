import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  DrawbackRule,
  PieceType,
  RuleMoveContext,
  RuleTransitionContext,
} from "../types.js";
import type { PlayerColor } from "@drawbackengine/shared";
import type { NoParameters } from "./common.js";
import {
  bipartisanshipRule,
  bottledLightingRule,
  chivalryRule,
  communityRulesTwo,
  coveringFireRule,
  escortMissionRule,
  evilTwinRule,
  exclusivityClauseRule,
  leapsAndBoundsRule,
  leftForDeadRule,
  outflankedRule,
  punchingDownRule,
  simplifierRule,
} from "./community-rules-two.js";

function move(
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly color?: PlayerColor;
    readonly captured?: PieceType;
    readonly promotion?: ChessMove["promotion"];
    readonly flags?: string;
  } = {},
): ChessMove {
  return {
    from,
    to,
    piece,
    color: options.color ?? "white",
    ...(options.captured === undefined ? {} : { captured: options.captured }),
    ...(options.promotion === undefined ? {} : { promotion: options.promotion }),
    san: `${from}${to}`,
    flags: options.flags ?? (options.captured === undefined ? "quiet" : "capture"),
  };
}

function context<State>(
  state: State,
  color: PlayerColor = "white",
): RuleMoveContext<State, NoParameters> {
  return {
    color,
    parameters: {},
    state,
    position: {
      fen: `8/8/8/8/8/8/8/8 ${color === "white" ? "w" : "b"} - - 0 1`,
      turn: color,
      ply: 0,
      history: [],
    },
  };
}

function transition<State>(
  state: State,
  color: PlayerColor = "white",
): RuleTransitionContext<State, NoParameters> {
  const before = context(state, color);
  return {
    ...before,
    positionAfterMove: {
      ...before.position,
      turn: color === "white" ? "black" : "white",
      ply: 1,
    },
  };
}

function allowed<State>(
  rule: DrawbackRule<State, NoParameters>,
  state: State,
  moves: readonly ChessMove[],
  color: PlayerColor = "white",
): readonly string[] {
  return rule
    .filterLegalMoves(context(state, color), Object.freeze([...moves]))
    .map(({ from, to, promotion }) => from + to + (promotion ?? ""));
}

const stateless = { movesApplied: 0 };

describe("second community batch metadata", () => {
  it("registers twelve executable but unverified rules", () => {
    expect(communityRulesTwo).toHaveLength(12);
    expect(new Set(communityRulesTwo.map(({ id }) => id)).size).toBe(12);
    expect(
      communityRulesTwo.every(
        ({ verification }) => verification === "implemented-unverified",
      ),
    ).toBe(true);
  });

  it("keeps catalog metadata and replay fixtures aligned", () => {
    const catalog = JSON.parse(readFileSync(
      new URL(
        "../../../../data/catalog/community-drawbacks-two.json",
        import.meta.url,
      ),
      "utf8",
    )) as readonly {
      readonly id: string;
      readonly implementationStatus: string;
      readonly fixture: string;
    }[];
    expect(catalog.map(({ id }) => id)).toEqual(
      communityRulesTwo.map(({ id }) => id),
    );
    for (const entry of catalog) {
      expect(entry.implementationStatus).toBe("implemented-unverified");
      const fixtureUrl = new URL(`../../../../${entry.fixture}`, import.meta.url);
      expect(existsSync(fixtureUrl)).toBe(true);
      expect(
        (JSON.parse(readFileSync(fixtureUrl, "utf8")) as { ruleId: string })
          .ruleId,
      ).toBe(entry.id);
    }
  });
});

describe("forced-move families", () => {
  it("Bottled Lighting forces all king moves, including castling", () => {
    const pawn = move("a2", "a4", "pawn");
    const king = move("e1", "d1", "king");
    const castle = move("e1", "g1", "king", { flags: "kingside-castle" });
    expect(allowed(bottledLightingRule, stateless, [pawn, king, castle]))
      .toEqual(["e1d1", "e1g1"]);
  });

  it("Escort Mission forces only king captures", () => {
    const quietKing = move("e1", "d1", "king");
    const kingCapture = move("e1", "e2", "king", { captured: "rook" });
    const queenCapture = move("d1", "d8", "queen", { captured: "queen" });
    expect(allowed(escortMissionRule, stateless, [
      quietKing,
      kingCapture,
      queenCapture,
    ])).toEqual(["e1e2"]);
  });

  it("Evil Twin forces exact same-type captures and treats en-passant as pawn-on-pawn", () => {
    const quiet = move("a2", "a3", "pawn");
    const knightTwin = move("b1", "c3", "knight", { captured: "knight" });
    const enPassant = move("e5", "d6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });
    expect(allowed(evilTwinRule, stateless, [quiet, knightTwin, enPassant]))
      .toEqual(["b1c3", "e5d6"]);
  });

  it("Simplifier compares pre-move values and keeps every promotion choice", () => {
    const quiet = move("a2", "a3", "pawn");
    const pawnTakesRook = move("a7", "b8", "pawn", {
      captured: "rook",
      promotion: "queen",
    });
    const queenTakesPawn = move("d1", "d7", "queen", { captured: "pawn" });
    expect(allowed(simplifierRule, stateless, [quiet, pawnTakesRook, queenTakesPawn]))
      .toEqual(["a7b8queen"]);
  });
});

describe("capture restrictions", () => {
  it("Chivalry allows only knights to capture rooks and queens", () => {
    const knight = move("b6", "a8", "knight", { captured: "queen" });
    const rook = move("a1", "a8", "rook", { captured: "queen" });
    const pawnPromotion = move("a7", "b8", "pawn", {
      captured: "rook",
      promotion: "knight",
    });
    const bishopTarget = move("a1", "a7", "rook", { captured: "bishop" });
    expect(allowed(chivalryRule, stateless, [
      knight,
      rook,
      pawnPromotion,
      bishopTarget,
    ])).toEqual(["b6a8", "a1a7"]);
  });

  it("Covering Fire deduplicates promotion variants by physical origin", () => {
    const loneQueen = move("a7", "b8", "pawn", {
      captured: "rook",
      promotion: "queen",
    });
    const loneKnight = move("a7", "b8", "pawn", {
      captured: "rook",
      promotion: "knight",
    });
    const supported = move("c7", "b8", "king", { captured: "rook" });
    expect(allowed(coveringFireRule, stateless, [loneQueen, loneKnight]))
      .toEqual([]);
    expect(allowed(coveringFireRule, stateless, [
      loneQueen,
      loneKnight,
      supported,
    ])).toEqual(["a7b8queen", "a7b8knight", "c7b8"]);
  });

  it("Left for Dead uses player-relative left and leaves quiet moves unrestricted", () => {
    const whiteLeft = move("e4", "d5", "pawn", { captured: "pawn" });
    const whiteRight = move("e4", "f5", "pawn", { captured: "pawn" });
    const quiet = move("e4", "e5", "pawn");
    expect(allowed(leftForDeadRule, stateless, [whiteLeft, whiteRight, quiet]))
      .toEqual(["e4d5", "e4e5"]);

    const blackLeft = move("e5", "f4", "pawn", {
      color: "black",
      captured: "pawn",
    });
    const blackRight = move("e5", "d4", "pawn", {
      color: "black",
      captured: "pawn",
    });
    expect(allowed(leftForDeadRule, stateless, [blackLeft, blackRight], "black"))
      .toEqual(["e5f4"]);
  });

  it("Outflanked blocks capture-promotions on the rim but not quiet promotions", () => {
    const capture = move("a7", "b8", "pawn", {
      captured: "rook",
      promotion: "queen",
    });
    const quiet = move("a7", "a8", "pawn", { promotion: "queen" });
    const interior = move("c3", "d4", "pawn", { captured: "bishop" });
    expect(allowed(outflankedRule, stateless, [capture, quiet, interior]))
      .toEqual(["a7a8queen", "c3d4"]);
  });

  it("Punching Down allows equal or lower-value targets only", () => {
    const pawnTakesRook = move("c3", "d4", "pawn", { captured: "rook" });
    const queenTakesRook = move("d1", "e2", "queen", { captured: "rook" });
    const enPassant = move("e5", "d6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });
    expect(allowed(punchingDownRule, stateless, [
      pawnTakesRook,
      queenTakesRook,
      enPassant,
    ])).toEqual(["d1e2", "e5d6"]);
  });
});

describe("destination and history restrictions", () => {
  it("Exclusivity Clause counts distinct origins rather than promotion variants", () => {
    const firstPromotion = move("a7", "a8", "pawn", { promotion: "queen" });
    const secondPromotion = move("a7", "a8", "pawn", { promotion: "rook" });
    const sharedOne = move("a1", "d1", "rook");
    const sharedTwo = move("c1", "d1", "king");
    expect(allowed(exclusivityClauseRule, stateless, [
      firstPromotion,
      secondPromotion,
      sharedOne,
      sharedTwo,
    ])).toEqual(["a7a8queen", "a7a8rook"]);
  });

  it("Leaps and Bounds rejects adjacent moves but permits castling and double pushes", () => {
    const king = move("e1", "d1", "king");
    const single = move("a2", "a3", "pawn");
    const double = move("a2", "a4", "pawn", { flags: "double-pawn" });
    const castle = move("e1", "g1", "king", { flags: "kingside-castle" });
    const knight = move("g1", "f3", "knight");
    expect(allowed(leapsAndBoundsRule, stateless, [
      king,
      single,
      double,
      castle,
      knight,
    ])).toEqual(["a2a4", "e1g1", "g1f3"]);
  });

  it("Bipartisanship resets its direction after a vertical move", () => {
    const right = move("a1", "b1", "rook");
    const left = move("b1", "a1", "rook");
    const vertical = move("a1", "a2", "rook");
    const afterRight = bipartisanshipRule.applyMove(
      transition({ previousHorizontalDirection: 0 }),
      right,
    );
    expect(allowed(bipartisanshipRule, afterRight, [right, left, vertical]))
      .toEqual(["b1a1", "a1a2"]);
    const afterVertical = bipartisanshipRule.applyMove(
      transition(afterRight),
      vertical,
    );
    expect(allowed(bipartisanshipRule, afterVertical, [right]))
      .toEqual(["a1b1"]);
  });
});
