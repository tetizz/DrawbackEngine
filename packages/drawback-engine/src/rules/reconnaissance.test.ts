import {
  Chess,
  type Color,
  type Move,
  type PieceSymbol,
} from "chess.js";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  PositionView,
  PromotionPiece,
  RuleMoveContext,
} from "../types.js";
import type { NoParameters } from "./common.js";
import {
  reconnaissanceRule,
  type ReconnaissanceState,
} from "./reconnaissance.js";

const PIECES: Readonly<Record<PieceSymbol, PieceType>> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

function color(value: Color): ChessMove["color"] {
  return value === "w" ? "white" : "black";
}

function chessMove(move: Move): ChessMove {
  return {
    from: move.from,
    to: move.to,
    color: color(move.color),
    piece: PIECES[move.piece],
    san: move.san,
    flags: [
      move.isCapture() ? "capture" : "quiet",
      move.isPromotion() ? "promotion" : "",
      move.isEnPassant() ? "en-passant" : "",
      move.isKingsideCastle() ? "kingside-castle" : "",
      move.isQueensideCastle() ? "queenside-castle" : "",
    ].filter((flag) => flag.length > 0).join(","),
    ...(move.captured === undefined
      ? {}
      : { captured: PIECES[move.captured] }),
    ...(move.promotion === undefined
      ? {}
      : { promotion: PIECES[move.promotion] as PromotionPiece }),
  };
}

function legalMoves(fen: string): readonly ChessMove[] {
  return new Chess(fen).moves({ verbose: true }).map(chessMove);
}

function position(
  fen: string,
  history: readonly ChessMove[] = [],
): PositionView {
  return {
    fen,
    turn: fen.split(" ")[1] === "b" ? "black" : "white",
    ply: history.length,
    history,
  };
}

function context(
  fen: string,
  state: ReconnaissanceState = {
    movesApplied: 0,
    unlockedCapturedTypes: [],
  },
): RuleMoveContext<ReconnaissanceState, NoParameters> {
  return {
    color: position(fen).turn,
    parameters: {},
    state,
    position: position(fen),
  };
}

function transition(
  fen: string,
  state: ReconnaissanceState,
): ReconnaissanceState {
  const move = legalMoves(fen)[0];
  if (move === undefined) {
    throw new Error("Test position requires at least one legal move.");
  }
  return reconnaissanceRule.applyMove(
    {
      ...context(fen, state),
      positionAfterMove: position(fen),
    },
    move,
  );
}

describe("Reconnaissance", () => {
  it("delays newly studied target types until the next affected turn", () => {
    const fen = "4k3/8/8/3p4/3Q3n/8/8/4K3 w - - 0 1";
    const ordinary = legalMoves(fen);
    const before = context(fen);
    expect(
      reconnaissanceRule.filterLegalMoves(before, ordinary)
        .every((move) => move.captured === undefined),
    ).toBe(true);

    const learned = transition(fen, before.state);
    expect(learned.unlockedCapturedTypes).toEqual(["pawn", "knight"]);
    expect(
      reconnaissanceRule.filterLegalMoves(
        context(fen, learned),
        ordinary,
      ).filter((move) => move.captured !== undefined)
        .map((move) => move.captured)
        .sort(),
    ).toEqual(["knight", "pawn"]);
  });

  it("unlocks multiple types canonically and preserves earlier studies", () => {
    const first = transition(
      "4k3/8/8/3p4/3Q3n/8/8/4K3 w - - 0 1",
      { movesApplied: 2, unlockedCapturedTypes: ["rook"] },
    );
    expect(first).toEqual({
      movesApplied: 3,
      unlockedCapturedTypes: ["pawn", "knight", "rook"],
    });
    const second = transition(
      "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
      first,
    );
    expect(second).toEqual({
      movesApplied: 4,
      unlockedCapturedTypes: ["pawn", "knight", "rook"],
    });
  });

  it("filters captures by captured target type, not mover type", () => {
    const fen = "4k3/8/8/3p4/3Q3n/8/8/4K3 w - - 0 1";
    const captures = legalMoves(fen).filter(
      (move) => move.captured !== undefined,
    );
    expect(
      reconnaissanceRule.filterLegalMoves(
        context(fen, {
          movesApplied: 3,
          unlockedCapturedTypes: ["knight"],
        }),
        captures,
      ).map((move) => move.captured),
    ).toEqual(["knight"]);
  });

  it("derives standard-legal opportunities for both colors", () => {
    const blackFen = "4k3/8/8/3q3N/3P4/8/8/4K3 b - - 0 1";
    expect(
      transition(blackFen, {
        movesApplied: 0,
        unlockedCapturedTypes: [],
      }).unlockedCapturedTypes,
    ).toEqual(["pawn", "knight"]);
    const representativeMove = legalMoves(blackFen)[0];
    expect(representativeMove).toBeDefined();
    if (representativeMove === undefined) {
      throw new Error("Expected the test position to have a legal move");
    }
    const history: readonly ChessMove[] = [
      { ...representativeMove, color: "white" },
      { ...representativeMove, color: "black" },
    ];
    expect(reconnaissanceRule.initialize({
      color: "black",
      parameters: {},
      position: position(blackFen, history),
    })).toEqual({
      movesApplied: 1,
      unlockedCapturedTypes: [],
    });
  });

  it("does not study pseudo-captures forbidden by pins or check", () => {
    const pinnedFen = "k3r3/8/8/8/8/8/4R2n/4K3 w - - 0 1";
    const learned = transition(pinnedFen, {
      movesApplied: 0,
      unlockedCapturedTypes: [],
    });
    expect(learned.unlockedCapturedTypes).toEqual(["rook"]);
    expect(
      legalMoves(pinnedFen).some(
        (move) => move.to === "h2" && move.captured === "knight",
      ),
    ).toBe(false);
  });

  it("studies en-passant and promotion-capture victims but not castling", () => {
    const enPassant = transition(
      "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
      { movesApplied: 0, unlockedCapturedTypes: [] },
    );
    expect(enPassant.unlockedCapturedTypes).toEqual(["pawn"]);

    const promotion = transition(
      "4k2r/6P1/8/8/8/8/8/4K3 w - - 0 1",
      { movesApplied: 0, unlockedCapturedTypes: [] },
    );
    expect(promotion.unlockedCapturedTypes).toEqual(["rook"]);

    const castleFen = "4k3/8/8/8/8/8/8/4K2R w K - 0 1";
    const castle = legalMoves(castleFen).find(
      (move) => move.flags.includes("kingside-castle"),
    );
    expect(castle).toBeDefined();
    expect(
      reconnaissanceRule.filterLegalMoves(
        context(castleFen),
        legalMoves(castleFen),
      ),
    ).toContainEqual(castle);
    expect(
      transition(castleFen, {
        movesApplied: 0,
        unlockedCapturedTypes: [],
      }).unlockedCapturedTypes,
    ).toEqual([]);
  });

  it("does not mutate legal-move inputs or prior state", () => {
    const fen = "4k3/8/8/3p4/3Q4/8/8/4K3 w - - 0 1";
    const ordinary = legalMoves(fen);
    const snapshot = structuredClone(ordinary);
    const state: ReconnaissanceState = {
      movesApplied: 4,
      unlockedCapturedTypes: ["pawn"],
    };
    const next = transition(fen, state);
    reconnaissanceRule.filterLegalMoves(context(fen, state), ordinary);
    expect(ordinary).toEqual(snapshot);
    expect(state).toEqual({
      movesApplied: 4,
      unlockedCapturedTypes: ["pawn"],
    });
    expect(next).not.toBe(state);
    expect(Object.isFrozen(next.unlockedCapturedTypes)).toBe(true);
  });

  it("can produce an empty mask when every legal move is a locked capture", () => {
    const fen = "k7/8/8/1b6/8/3B4/3NrN2/3NKN2 w - - 0 1";
    const ordinary = legalMoves(fen);
    expect(ordinary.length).toBeGreaterThan(0);
    expect(ordinary.every((move) => move.captured === "rook")).toBe(true);
    expect(
      reconnaissanceRule.filterLegalMoves(context(fen), ordinary),
    ).toEqual([]);
  });
});
