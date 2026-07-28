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
  alternatorRule,
  champingAtTheBitRule,
  communityRules,
  controlCenterRule,
  elephantsFearMiceRule,
  farSightedRule,
  greedyRule,
  hopscotchRule,
  indecisiveRule,
  outOfBreathRule,
  professionalCourtesyRule,
  queenBeeRule,
  scentOfBloodRule,
  snipersRule,
  stayAtHomeMomRule,
  whitesOfTheirEyesRule,
} from "./community-rules.js";

function move(
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly color?: PlayerColor;
    readonly captured?: PieceType;
    readonly flags?: string;
    readonly promotion?: ChessMove["promotion"];
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
    .map(({ from, to }) => from + to);
}

const stateless = { movesApplied: 0 };
const statelessAuthorityAuditedCommunityRules = [
  greedyRule,
  professionalCourtesyRule,
  snipersRule,
  stayAtHomeMomRule,
  elephantsFearMiceRule,
  farSightedRule,
  whitesOfTheirEyesRule,
  champingAtTheBitRule,
  scentOfBloodRule,
  indecisiveRule,
  controlCenterRule,
] as const;
const authorityAuditedCommunityRules = [
  ...statelessAuthorityAuditedCommunityRules,
  outOfBreathRule,
  queenBeeRule,
  alternatorRule,
  hopscotchRule,
] as const;

describe("community rule metadata", () => {
  it("registers fifteen executable but unverified rules", () => {
    expect(communityRules).toHaveLength(15);
    expect(new Set(communityRules.map(({ id }) => id)).size).toBe(15);
    expect(communityRules.every(
      ({ verification }) => verification === "implemented-unverified",
    )).toBe(true);
  });

  it("declares both authorities for all fifteen audited rules", () => {
    expect(authorityAuditedCommunityRules.map(({ id }) => id)).toEqual([
      "greedy",
      "professional-courtesy",
      "snipers",
      "stay-at-home-mom",
      "elephants-fear-mice",
      "far-sighted",
      "whites-of-their-eyes",
      "champing-at-the-bit",
      "scent-of-blood",
      "indecisive",
      "control-center",
      "out-of-breath",
      "queen-bee",
      "alternator",
      "hopscotch",
    ]);
    for (const rule of authorityAuditedCommunityRules) {
      expect(rule.supportedAuthorities).toEqual([
        "standard-chess/v1",
        "capturable-king/v1",
      ]);
      expect(Object.isFrozen(rule.supportedAuthorities)).toBe(true);
    }
    const auditedIds = new Set(
      authorityAuditedCommunityRules.map(({ id }) => id),
    );
    expect(
      communityRules.filter(({ id }) => !auditedIds.has(id)),
    ).toEqual([]);
  });

  it.each(statelessAuthorityAuditedCommunityRules)(
    "$name filters without mutating or aliasing the authority move set",
    (rule) => {
      const moves = Object.freeze([
        Object.freeze(move("a1", "a2", "rook")),
        Object.freeze(
          move("a1", "a8", "rook", { captured: "king" }),
        ),
      ]);
      const before = structuredClone(moves);
      const filtered = rule.filterLegalMoves(context(stateless), moves);
      expect(filtered).not.toBe(moves);
      expect(moves).toEqual(before);
    },
  );

  it("keeps catalog metadata and replay fixtures aligned", () => {
    const catalog = JSON.parse(readFileSync(
      new URL(
        "../../../../data/catalog/community-drawbacks.json",
        import.meta.url,
      ),
      "utf8",
    )) as readonly {
      readonly id: string;
      readonly implementationStatus: string;
      readonly fixture: string;
    }[];
    expect(catalog.map(({ id }) => id)).toEqual(
      communityRules.map(({ id }) => id),
    );
    expect(catalog.every(
      ({ implementationStatus }) =>
        implementationStatus === "implemented-unverified",
    )).toBe(true);
    for (const entry of catalog) {
      const fixtureUrl = new URL(`../../../../${entry.fixture}`, import.meta.url);
      expect(existsSync(fixtureUrl)).toBe(true);
      expect(
        (JSON.parse(readFileSync(fixtureUrl, "utf8")) as { ruleId: string })
          .ruleId,
      ).toBe(entry.id);
    }
  });
});

describe("capture value and type families", () => {
  it("Greedy allows quiet moves and only maximum-value captures", () => {
    const quiet = move("a2", "a3", "pawn");
    const pawn = move("b2", "c3", "pawn", { captured: "pawn" });
    const rook = move("d1", "d8", "queen", { captured: "rook" });
    expect(allowed(greedyRule, stateless, [quiet, pawn, rook]))
      .toEqual(["a2a3", "d1d8"]);
  });

  it("Professional Courtesy classifies direct king and promotion captures by primary types", () => {
    const quiet = move("h1", "h2", "king");
    const kingTakesKing = move("e1", "e2", "king", {
      captured: "king",
    });
    const rookTakesKing = move("a1", "a8", "rook", {
      captured: "king",
    });
    const knightTakesPawn = move("b1", "a3", "knight", {
      captured: "pawn",
    });
    const promotionTakesKing = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "queen",
    });
    const enPassant = move("e5", "d6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });
    expect(allowed(professionalCourtesyRule, stateless, [
      quiet,
      kingTakesKing,
      rookTakesKing,
      knightTakesPawn,
      promotionTakesKing,
      enPassant,
    ])).toEqual(["h1h2", "a1a8", "b1a3", "a7b8", "e5d6"]);

    const blackKingTakesKing = move("e8", "e7", "king", {
      color: "black",
      captured: "king",
    });
    const blackRookTakesKing = move("a8", "a1", "rook", {
      color: "black",
      captured: "king",
    });
    expect(allowed(
      professionalCourtesyRule,
      stateless,
      [blackKingTakesKing, blackRookTakesKing],
      "black",
    )).toEqual(["a8a1"]);
  });

  it("Elephants Fear Mice restricts pawn targets, not direct king targets", () => {
    const quiet = move("a1", "a2", "rook");
    const rook = move("a1", "a7", "rook", { captured: "pawn" });
    const king = move("e1", "e2", "king", { captured: "pawn" });
    const kingTarget = move("h1", "h8", "rook", { captured: "king" });
    const enPassant = move("b5", "a6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });
    const promotion = move("b7", "a8", "pawn", {
      captured: "pawn",
      promotion: "rook",
    });
    expect(allowed(elephantsFearMiceRule, stateless, [
      quiet,
      rook,
      king,
      kingTarget,
      enPassant,
      promotion,
    ])).toEqual(["a1a2", "h1h8", "b5a6", "b7a8"]);

    const blackKingTarget = move("h8", "h1", "rook", {
      color: "black",
      captured: "king",
    });
    const blackPawnTarget = move("a8", "a2", "rook", {
      color: "black",
      captured: "pawn",
    });
    expect(allowed(
      elephantsFearMiceRule,
      stateless,
      [blackKingTarget, blackPawnTarget],
      "black",
    )).toEqual(["h8h1"]);
  });
});

describe("capture geometry families", () => {
  it("Snipers applies its four-diagonal minimum to direct king captures for both colors", () => {
    const short = move("c1", "e3", "bishop", { captured: "king" });
    const long = move("c1", "g5", "bishop", { captured: "king" });
    const quiet = move("c1", "d2", "bishop");
    const rookCapture = move("a1", "a8", "rook", { captured: "king" });
    const promotionCapture = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "bishop",
    });
    expect(allowed(snipersRule, stateless, [
      short,
      long,
      quiet,
      rookCapture,
      promotionCapture,
    ])).toEqual(["c1g5", "c1d2", "a1a8", "a7b8"]);

    const blackShort = move("f8", "d6", "bishop", {
      color: "black",
      captured: "king",
    });
    const blackLong = move("f8", "b4", "bishop", {
      color: "black",
      captured: "king",
    });
    expect(allowed(
      snipersRule,
      stateless,
      [blackShort, blackLong],
      "black",
    )).toEqual(["f8b4"]);
  });

  it("Far Sighted blocks adjacent king, promotion, and en-passant captures but not quiet moves", () => {
    const adjacent = move("e4", "e5", "rook", { captured: "king" });
    const diagonal = move("e4", "f5", "bishop", { captured: "pawn" });
    const remote = move("e4", "e8", "rook", { captured: "king" });
    const adjacentQuiet = move("e4", "f5", "bishop");
    const enPassant = move("e5", "d6", "pawn", {
      flags: "en-passant",
    });
    const promotionCapture = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "queen",
    });
    const quietPromotion = move("a7", "a8", "pawn", {
      promotion: "queen",
    });
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(allowed(farSightedRule, stateless, [
      adjacent,
      diagonal,
      remote,
      adjacentQuiet,
      enPassant,
      promotionCapture,
      quietPromotion,
      castle,
    ])).toEqual(["e4e8", "e4f5", "a7a8", "e1g1"]);

    const blackAdjacent = move("e5", "e4", "rook", {
      color: "black",
      captured: "king",
    });
    const blackRemote = move("e5", "e1", "rook", {
      color: "black",
      captured: "king",
    });
    expect(allowed(
      farSightedRule,
      stateless,
      [blackAdjacent, blackRemote],
      "black",
    )).toEqual(["e5e1"]);
  });

  it("Whites of Their Eyes uses Manhattan distance for terminal and special captures", () => {
    const diagonalOne = move("e4", "f5", "bishop", { captured: "king" });
    const knight = move("e4", "f6", "knight", { captured: "king" });
    const remote = move("e4", "e8", "rook", { captured: "king" });
    const quiet = move("a1", "a8", "rook");
    const enPassant = move("e5", "d6", "pawn", {
      flags: "en-passant",
    });
    const promotionCapture = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "knight",
    });
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(allowed(whitesOfTheirEyesRule, stateless, [
      diagonalOne,
      knight,
      remote,
      quiet,
      enPassant,
      promotionCapture,
      castle,
    ])).toEqual(["e4f5", "a1a8", "e5d6", "a7b8", "e1g1"]);

    const blackNear = move("e5", "d4", "bishop", {
      color: "black",
      captured: "king",
    });
    const blackFar = move("e5", "e1", "rook", {
      color: "black",
      captured: "king",
    });
    expect(allowed(
      whitesOfTheirEyesRule,
      stateless,
      [blackNear, blackFar],
      "black",
    )).toEqual(["e5d4"]);
  });
});

describe("destination and opportunity families", () => {
  it("Stay at Home Mom applies color-relative home ranks to quiet and king captures", () => {
    const whiteHome = move("d1", "d2", "queen");
    const whiteAway = move("d1", "d3", "queen");
    const whiteHomeCapture = move("e1", "e2", "queen", {
      captured: "king",
    });
    const whiteAwayCapture = move("e1", "e8", "queen", {
      captured: "king",
    });
    const promotion = move("a7", "a8", "pawn", {
      promotion: "queen",
    });
    const enPassant = move("e5", "d6", "pawn", {
      flags: "en-passant",
    });
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    const blackHome = move("d8", "d7", "queen", { color: "black" });
    const blackAway = move("d8", "d6", "queen", { color: "black" });
    const blackHomeCapture = move("e8", "e7", "queen", {
      color: "black",
      captured: "king",
    });
    const blackAwayCapture = move("e8", "e1", "queen", {
      color: "black",
      captured: "king",
    });
    expect(allowed(stayAtHomeMomRule, stateless, [
      whiteHome,
      whiteAway,
      whiteHomeCapture,
      whiteAwayCapture,
      promotion,
      enPassant,
      castle,
    ])).toEqual(["d1d2", "e1e2", "a7a8", "e5d6", "e1g1"]);
    expect(allowed(
      stayAtHomeMomRule,
      stateless,
      [blackHome, blackAway, blackHomeCapture, blackAwayCapture],
      "black",
    )).toEqual(["d8d7", "e8e7"]);
  });

  it("Champing at the Bit classifies promotions, en-passant, and king captures by the pawn move", () => {
    const single = move("e2", "e3", "pawn");
    const double = move("e2", "e4", "pawn");
    const capture = move("e4", "f5", "pawn", { captured: "king" });
    const nonPawnCapture = move("a1", "a8", "rook", {
      captured: "king",
    });
    const enPassant = move("e5", "d6", "pawn", {
      flags: "en-passant",
    });
    const quietPromotion = move("a7", "a8", "pawn", {
      promotion: "queen",
    });
    const capturePromotion = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "rook",
    });
    const castle = move("e1", "g1", "king", { flags: "kingside-castle" });
    expect(allowed(champingAtTheBitRule, stateless, [
      single,
      double,
      capture,
      nonPawnCapture,
      enPassant,
      quietPromotion,
      capturePromotion,
      castle,
    ])).toEqual([
      "e2e4",
      "e4f5",
      "a1a8",
      "e5d6",
      "a7b8",
      "e1g1",
    ]);

    const blackSingle = move("e7", "e6", "pawn", { color: "black" });
    const blackDouble = move("e7", "e5", "pawn", { color: "black" });
    const blackPromotionCapture = move("h2", "g1", "pawn", {
      color: "black",
      captured: "king",
      promotion: "bishop",
    });
    expect(allowed(
      champingAtTheBitRule,
      stateless,
      [blackSingle, blackDouble, blackPromotionCapture],
      "black",
    )).toEqual(["e7e5", "h2g1"]);
  });

  it("The Scent of Blood treats a direct king capture as local to its physical piece", () => {
    const rookQuiet = move("a1", "a2", "rook");
    const rookCapture = move("a1", "a8", "rook", { captured: "king" });
    const otherRookQuiet = move("h1", "h2", "rook");
    const pawnQuiet = move("b2", "b3", "pawn");
    expect(allowed(scentOfBloodRule, stateless, [
      rookQuiet,
      rookCapture,
      otherRookQuiet,
      pawnQuiet,
    ])).toEqual(["a1a8", "h1h2", "b2b3"]);

    const blackQuiet = move("a8", "a7", "rook", { color: "black" });
    const blackKingCapture = move("a8", "a1", "rook", {
      color: "black",
      captured: "king",
    });
    expect(allowed(
      scentOfBloodRule,
      stateless,
      [blackQuiet, blackKingCapture],
      "black",
    )).toEqual(["a8a1"]);
  });

  it("The Scent of Blood recognizes special captures before quiet special moves", () => {
    const enPassant = move("e5", "d6", "pawn", {
      flags: "en-passant",
    });
    const pawnQuiet = move("e5", "e6", "pawn");
    const promotionCapture = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "queen",
    });
    const quietPromotion = move("a7", "a8", "pawn", {
      promotion: "queen",
    });
    const kingCapture = move("e1", "e2", "king", {
      captured: "king",
    });
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(allowed(scentOfBloodRule, stateless, [
      enPassant,
      pawnQuiet,
      promotionCapture,
      quietPromotion,
      kingCapture,
      castle,
    ])).toEqual(["e5d6", "a7b8", "e1e2"]);
  });

  it("Indecisive counts king captures per source square, not per piece type", () => {
    const first = move("d4", "d8", "queen", { captured: "king" });
    const second = move("d4", "h4", "queen", { captured: "bishop" });
    const quiet = move("d4", "d5", "queen");
    const sole = move("a1", "a8", "queen", { captured: "king" });
    expect(allowed(indecisiveRule, stateless, [first, second, quiet, sole]))
      .toEqual(["d4d5", "a1a8"]);

    const blackKingCapture = move("d5", "d1", "queen", {
      color: "black",
      captured: "king",
    });
    const blackOtherCapture = move("d5", "h5", "queen", {
      color: "black",
      captured: "rook",
    });
    const blackQuiet = move("d5", "d4", "queen", { color: "black" });
    expect(allowed(
      indecisiveRule,
      stateless,
      [blackKingCapture, blackOtherCapture, blackQuiet],
      "black",
    )).toEqual(["d5d4"]);
  });

  it("Indecisive counts en-passant and promotion variants as ordinary capture moves", () => {
    const enPassant = move("e5", "d6", "pawn", {
      flags: "en-passant",
    });
    const ordinaryCapture = move("e5", "f6", "pawn", {
      captured: "knight",
    });
    const quiet = move("e5", "e6", "pawn");
    const promoteToQueen = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "queen",
    });
    const promoteToRook = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "rook",
    });
    const quietPromotion = move("a7", "a8", "pawn", {
      promotion: "queen",
    });
    expect(allowed(indecisiveRule, stateless, [
      enPassant,
      ordinaryCapture,
      quiet,
      promoteToQueen,
      promoteToRook,
      quietPromotion,
    ])).toEqual(["e5e6", "a7a8"]);
  });

  it("Control Center exempts captures but classifies castling and promotion by destination", () => {
    const central = move("a2", "c2", "rook");
    const outside = move("a2", "b2", "rook");
    const capture = move("a2", "a8", "rook", { captured: "king" });
    const enPassant = move("a5", "b6", "pawn", {
      flags: "en-passant",
    });
    const promotionCapture = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "queen",
    });
    const quietPromotion = move("a7", "a8", "pawn", {
      promotion: "queen",
    });
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(allowed(controlCenterRule, stateless, [
      central,
      outside,
      capture,
      enPassant,
      promotionCapture,
      quietPromotion,
      castle,
    ])).toEqual(["a2c2", "a2a8", "a5b6", "a7b8"]);

    const blackCentral = move("h7", "f7", "rook", { color: "black" });
    const blackOutside = move("h7", "g7", "rook", { color: "black" });
    const blackKingCapture = move("h8", "h1", "rook", {
      color: "black",
      captured: "king",
    });
    expect(allowed(
      controlCenterRule,
      stateless,
      [blackCentral, blackOutside, blackKingCapture],
      "black",
    )).toEqual(["h7f7", "h8h1"]);
  });
});

describe("stateful community rules", () => {
  it("Out of Breath consumes the king budget on castling", () => {
    const castle = move("e1", "g1", "king", { flags: "kingside-castle" });
    const pawn = move("a2", "a4", "pawn");
    const next = outOfBreathRule.applyMove(
      transition({ kingMoves: 0 }),
      castle,
    );
    expect(next).toEqual({ kingMoves: 1 });
    expect(allowed(outOfBreathRule, next, [castle, pawn])).toEqual(["a2a4"]);
  });

  it("Queen Bee freezes every queen only after a queen capture", () => {
    const queenCapture = move("d1", "d7", "queen", { captured: "pawn" });
    const queenQuiet = move("d1", "d2", "queen");
    const rook = move("a1", "a2", "rook");
    const next = queenBeeRule.applyMove(
      transition({ queenCaptureOccurred: false }),
      queenCapture,
    );
    expect(next.queenCaptureOccurred).toBe(true);
    expect(allowed(queenBeeRule, next, [queenQuiet, rook])).toEqual(["a1a2"]);
  });

  it("Alternator starts unrestricted then alternates pawn class", () => {
    const pawn = move("e2", "e4", "pawn");
    const knight = move("g1", "f3", "knight");
    const afterPawn = alternatorRule.applyMove(
      transition({ previousClass: null }),
      pawn,
    );
    expect(allowed(alternatorRule, afterPawn, [pawn, knight])).toEqual(["g1f3"]);
  });

  it("Hopscotch alternates destination color across every move kind", () => {
    const dark = move("a1", "b2", "bishop");
    const light = move("a1", "a2", "rook");
    const afterDark = hopscotchRule.applyMove(
      transition({ previousClass: null }),
      dark,
    );
    expect(allowed(hopscotchRule, afterDark, [dark, light])).toEqual(["a1a2"]);
  });
});
