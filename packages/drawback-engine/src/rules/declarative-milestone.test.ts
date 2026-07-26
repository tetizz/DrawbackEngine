import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  PromotionPiece,
  RuleMoveContext,
} from "../index.js";
import type { PlayerColor } from "@drawbackengine/shared";
import type { NoParameters, StatelessRuleState } from "./common.js";
import { cessRule } from "./cess.js";
import { conscientiousObjectorsRule } from "./conscientious-objectors.js";
import { evenKeeledRule } from "./even-keeled.js";
import { falseProphetsRule } from "./false-prophets.js";
import { forwardMarchRule } from "./forward-march.js";
import { horseTranquilizerRule } from "./horse-tranquilizer.js";
import { oddballRule } from "./oddball.js";
import { pacmanRule } from "./pacman.js";
import { trophyWifeRule } from "./trophy-wife.js";
import { trueGentlemanRule } from "./true-gentleman.js";

interface MoveInput {
  readonly from: string;
  readonly to: string;
  readonly color?: PlayerColor;
  readonly piece: PieceType;
  readonly captured?: PieceType;
  readonly promotion?: PromotionPiece;
  readonly flags?: string;
}

function move(input: MoveInput): ChessMove {
  return {
    from: input.from,
    to: input.to,
    color: input.color ?? "white",
    piece: input.piece,
    ...(input.captured === undefined ? {} : { captured: input.captured }),
    ...(input.promotion === undefined ? {} : { promotion: input.promotion }),
    san: `${input.from}-${input.to}`,
    flags: input.flags ?? (input.captured === undefined ? "quiet" : "capture"),
  };
}

function context(
  fullmove = 1,
  color: PlayerColor = "white",
): RuleMoveContext<StatelessRuleState, NoParameters> {
  return {
    color,
    parameters: {},
    state: { movesApplied: 0 },
    position: {
      fen:
        `8/8/8/8/8/8/8/8 ${color === "white" ? "w" : "b"} - - 0 ` +
        String(fullmove),
      turn: color,
      ply: (fullmove - 1) * 2 + (color === "black" ? 1 : 0),
      history: [],
    },
  };
}

const quiet = move({ from: "a2", to: "a3", piece: "pawn" });
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

describe("declarative milestone metadata", () => {
  it("marks all ten sourced interpretations implemented-unverified", () => {
    expect([
      trueGentlemanRule,
      falseProphetsRule,
      trophyWifeRule,
      cessRule,
      forwardMarchRule,
      pacmanRule,
      oddballRule,
      evenKeeledRule,
      conscientiousObjectorsRule,
      horseTranquilizerRule,
    ].map(({ verification }) => verification)).toEqual(
      Array.from({ length: 10 }, () => "implemented-unverified"),
    );
  });
});

describe("False Prophets", () => {
  it("forbids bishop captures while preserving quiet bishop moves and other captures", () => {
    const bishopCapture = move({
      from: "d3",
      to: "f5",
      piece: "bishop",
      captured: "rook",
    });
    const bishopQuiet = move({ from: "d3", to: "e4", piece: "bishop" });
    const knightCapture = move({
      from: "e3",
      to: "f5",
      piece: "knight",
      captured: "rook",
    });
    expect(falseProphetsRule.filterLegalMoves(context(), [
      bishopCapture,
      bishopQuiet,
      knightCapture,
    ])).toEqual([bishopQuiet, knightCapture]);
  });

  it("forbids bishop captures on promotion targets and leaves castling and en-passant alone", () => {
    const bishopCapture = move({
      from: "a7",
      to: "b8",
      piece: "bishop",
      captured: "rook",
    });
    expect(falseProphetsRule.filterLegalMoves(context(), [
      bishopCapture,
      castle,
      enPassant,
    ])).toEqual([castle, enPassant]);
  });
});

describe("True Gentleman", () => {
  it("forbids capturing a queen with any mover while permitting other captures", () => {
    const queenCapture = move({
      from: "c4",
      to: "f7",
      piece: "bishop",
      captured: "queen",
    });
    const pawnCapture = move({
      from: "c4",
      to: "d5",
      piece: "bishop",
      captured: "pawn",
    });
    expect(trueGentlemanRule.filterLegalMoves(context(), [
      quiet,
      queenCapture,
      pawnCapture,
    ])).toEqual([quiet, pawnCapture]);
  });

  it("forbids a promotion that captures a queen and leaves special non-captures alone", () => {
    const promotionCapture = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "queen",
      promotion: "rook",
      flags: "capture,promotion",
    });
    expect(trueGentlemanRule.filterLegalMoves(context(), [
      promotionCapture,
      enPassant,
      castle,
    ])).toEqual([enPassant, castle]);
  });
});

describe("Trophy Wife", () => {
  it("forbids queen captures but permits quiet queen moves", () => {
    const queenCapture = move({
      from: "d1",
      to: "d7",
      piece: "queen",
      captured: "rook",
    });
    const queenQuiet = move({ from: "d1", to: "h5", piece: "queen" });
    expect(trophyWifeRule.filterLegalMoves(context(), [queenCapture, queenQuiet]))
      .toEqual([queenQuiet]);
  });

  it("classifies promotion by the pawn mover and does not affect en-passant or castling", () => {
    const capturingPromotion = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(trophyWifeRule.filterLegalMoves(context(), [
      capturingPromotion,
      enPassant,
      castle,
    ])).toEqual([capturingPromotion, enPassant, castle]);
  });
});

describe("Cess", () => {
  it("forbids quiet and capturing primary destinations on the h-file", () => {
    const quietToH = move({ from: "g2", to: "h3", piece: "king" });
    const captureToH = move({
      from: "g2",
      to: "h3",
      piece: "king",
      captured: "bishop",
    });
    expect(cessRule.filterLegalMoves(context(), [quiet, quietToH, captureToH]))
      .toEqual([quiet]);
  });

  it("forbids h-file promotion and en-passant destinations but permits castling", () => {
    const promotion = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(cessRule.filterLegalMoves(context(), [promotion, enPassant, castle]))
      .toEqual([castle]);
  });
});

describe("Forward March", () => {
  it("uses White's perspective and permits forward and lateral moves", () => {
    const forward = move({ from: "c3", to: "c5", piece: "rook" });
    const lateral = move({ from: "c3", to: "h3", piece: "rook" });
    const backward = move({ from: "c3", to: "c2", piece: "rook" });
    expect(forwardMarchRule.filterLegalMoves(context(), [forward, lateral, backward]))
      .toEqual([forward, lateral]);
  });

  it("reverses direction for Black, including knight captures", () => {
    const blackForward = move({
      from: "f6",
      to: "e4",
      color: "black",
      piece: "knight",
      captured: "pawn",
    });
    const blackBackward = move({
      from: "f6",
      to: "g8",
      color: "black",
      piece: "knight",
    });
    expect(forwardMarchRule.filterLegalMoves(
      context(1, "black"),
      [blackForward, blackBackward],
    )).toEqual([blackForward]);
  });

  it("permits forward promotion, en-passant, and rank-neutral castling", () => {
    const promotion = move({
      from: "a7",
      to: "a8",
      piece: "pawn",
      promotion: "queen",
      flags: "quiet,promotion",
    });
    expect(forwardMarchRule.filterLegalMoves(context(), [
      promotion,
      enPassant,
      castle,
    ])).toEqual([promotion, enPassant, castle]);
  });
});

describe("Pacman", () => {
  it("preserves a fresh copy of all moves when no pawn capture exists", () => {
    const knightCapture = move({
      from: "f3",
      to: "e5",
      piece: "knight",
      captured: "bishop",
    });
    const input = [quiet, knightCapture, castle];
    const result = pacmanRule.filterLegalMoves(context(), input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it("retains all and only pawn-target captures when one is available", () => {
    const pawnCapture = move({
      from: "c4",
      to: "d5",
      piece: "bishop",
      captured: "pawn",
    });
    const rookCapture = move({
      from: "a1",
      to: "a8",
      piece: "rook",
      captured: "rook",
    });
    expect(pacmanRule.filterLegalMoves(context(), [
      quiet,
      pawnCapture,
      rookCapture,
      castle,
    ])).toEqual([pawnCapture]);
  });

  it("recognizes en-passant and a capturing promotion whose target is a pawn", () => {
    const promotionCapture = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "pawn",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(pacmanRule.filterLegalMoves(context(), [
      quiet,
      enPassant,
      promotionCapture,
    ])).toEqual([enPassant, promotionCapture]);
  });
});

describe("capture parity rules", () => {
  const capture = move({
    from: "c4",
    to: "d5",
    piece: "bishop",
    captured: "pawn",
  });
  const promotionCapture = move({
    from: "g7",
    to: "h8",
    piece: "pawn",
    captured: "rook",
    promotion: "queen",
    flags: "capture,promotion",
  });

  it.each([
    ["white", oddballRule, 1, true],
    ["black", oddballRule, 1, true],
    ["white", oddballRule, 2, false],
    ["black", oddballRule, 2, false],
    ["white", evenKeeledRule, 1, false],
    ["black", evenKeeledRule, 1, false],
    ["white", evenKeeledRule, 2, true],
    ["black", evenKeeledRule, 2, true],
  ] as const)(
    "%s parity filters captures by fullmove for %s at move %i",
    (color, rule, fullmove, captureAllowed) => {
      const coloredCapture = { ...capture, color };
      const coloredEnPassant = { ...enPassant, color };
      const coloredPromotion = { ...promotionCapture, color };
      const coloredQuiet = { ...quiet, color };
      const coloredCastle = { ...castle, color };
      const result = rule.filterLegalMoves(context(fullmove, color), [
        coloredCapture,
        coloredEnPassant,
        coloredPromotion,
        coloredQuiet,
        coloredCastle,
      ]);
      expect(result).toEqual(
        captureAllowed
          ? [
              coloredCapture,
              coloredEnPassant,
              coloredPromotion,
              coloredQuiet,
              coloredCastle,
            ]
          : [coloredQuiet, coloredCastle],
      );
    },
  );
});

describe("Conscientious Objectors", () => {
  it("forbids ordinary pawn captures and en-passant", () => {
    const pawnCapture = move({
      from: "c4",
      to: "d5",
      piece: "pawn",
      captured: "bishop",
    });
    const bishopCapture = move({
      from: "c4",
      to: "d5",
      piece: "bishop",
      captured: "pawn",
    });
    expect(conscientiousObjectorsRule.filterLegalMoves(context(), [
      quiet,
      pawnCapture,
      enPassant,
      bishopCapture,
    ])).toEqual([quiet, bishopCapture]);
  });

  it("forbids capturing promotion but permits quiet promotion and castling", () => {
    const capturingPromotion = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    const quietPromotion = move({
      from: "a7",
      to: "a8",
      piece: "pawn",
      promotion: "queen",
      flags: "quiet,promotion",
    });
    expect(conscientiousObjectorsRule.filterLegalMoves(context(), [
      capturingPromotion,
      quietPromotion,
      castle,
    ])).toEqual([quietPromotion, castle]);
  });
});

describe("Horse Tranquilizer", () => {
  it("forbids knight captures while permitting quiet knight moves", () => {
    const knightCapture = move({
      from: "f3",
      to: "e5",
      piece: "knight",
      captured: "bishop",
    });
    const knightQuiet = move({ from: "g1", to: "f3", piece: "knight" });
    expect(horseTranquilizerRule.filterLegalMoves(context(), [
      knightCapture,
      knightQuiet,
    ])).toEqual([knightQuiet]);
  });

  it("permits pawn capture-promotion to knight, en-passant, and castling", () => {
    const knightPromotionCapture = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "knight",
      flags: "capture,promotion",
    });
    expect(horseTranquilizerRule.filterLegalMoves(context(), [
      knightPromotionCapture,
      enPassant,
      castle,
    ])).toEqual([knightPromotionCapture, enPassant, castle]);
  });
});
