import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  PositionView,
} from "../types.js";
import {
  absolutionRule,
  bloodthirstyRule,
  fixationRule,
  levelingUpRule,
  movingDayRule,
  nextStatefulRules,
  quicksandRule,
  siegeRule,
  type AbsolutionState,
  type BloodthirstyState,
  type FixationState,
  type LevelingUpState,
  type QuicksandState,
} from "./next-stateful-rules.js";

const BASE_FEN = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";

function move(
  color: ChessMove["color"],
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly captured?: PieceType;
    readonly promotion?: ChessMove["promotion"];
    readonly flags?: string;
  } = {},
): ChessMove {
  return {
    color,
    from,
    to,
    piece,
    san: `${from}-${to}`,
    flags: options.flags ??
      (options.captured === undefined ? "quiet" : "capture"),
    ...(options.captured === undefined ? {} : { captured: options.captured }),
    ...(options.promotion === undefined ? {} : { promotion: options.promotion }),
  };
}

function position(
  fen = BASE_FEN,
  history: readonly ChessMove[] = [],
  turn: ChessMove["color"] = "white",
): PositionView {
  return { fen, history, turn, ply: history.length };
}

function moveContext<State>(
  state: State,
  fen = BASE_FEN,
  history: readonly ChessMove[] = [],
  color: ChessMove["color"] = "white",
) {
  return {
    color,
    parameters: {},
    state,
    position: position(fen, history, color),
  };
}

function transitionContext<State>(
  state: State,
  beforeFen: string,
  afterFen: string,
  history: readonly ChessMove[] = [],
  color: ChessMove["color"] = "white",
) {
  return {
    ...moveContext(state, beforeFen, history, color),
    positionAfterMove: position(afterFen, history, color === "white" ? "black" : "white"),
  };
}

describe("next stateful rules", () => {
  it("has unique implemented-unverified metadata", () => {
    expect(nextStatefulRules).toHaveLength(7);
    expect(new Set(nextStatefulRules.map(({ id }) => id)).size).toBe(7);
    expect(nextStatefulRules.every(
      ({ verification }) => verification === "implemented-unverified",
    )).toBe(true);
  });

  it("Bloodthirsty grants three turns, then forces capture after two quiet turns", () => {
    const quiet = move("white", "a2", "a3", "pawn");
    const capture = move("white", "a2", "b3", "pawn", {
      captured: "pawn",
    });
    let state: BloodthirstyState = {
      movesApplied: 0,
      quietTurnsAfterGrace: 0,
    };
    for (let index = 0; index < 3; index += 1) {
      state = bloodthirstyRule.applyMove(
        transitionContext(state, BASE_FEN, BASE_FEN),
        quiet,
      );
    }
    expect(state.quietTurnsAfterGrace).toBe(0);
    state = bloodthirstyRule.applyMove(
      transitionContext(state, BASE_FEN, BASE_FEN),
      quiet,
    );
    state = bloodthirstyRule.applyMove(
      transitionContext(state, BASE_FEN, BASE_FEN),
      quiet,
    );
    expect(bloodthirstyRule.filterLegalMoves(
      moveContext(state),
      [quiet, capture],
    )).toEqual([capture]);
    expect(bloodthirstyRule.filterLegalMoves(
      moveContext(state),
      [quiet],
    )).toEqual([]);
  });

  it("Bloodthirsty reconstructs and resets its streak on every capture type", () => {
    const history = [
      move("white", "a2", "a3", "pawn"),
      move("white", "b2", "b3", "pawn"),
      move("white", "c2", "c3", "pawn"),
      move("white", "d2", "d3", "pawn"),
      move("white", "e2", "e3", "pawn"),
    ];
    const initialized = bloodthirstyRule.initialize({
      color: "white",
      parameters: {},
      position: position(BASE_FEN, history),
    });
    expect(initialized.quietTurnsAfterGrace).toBe(2);
    const enPassant = move("white", "e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    expect(bloodthirstyRule.applyMove(
      transitionContext(initialized, BASE_FEN, BASE_FEN),
      enPassant,
    ).quietTurnsAfterGrace).toBe(0);
  });

  it("Fixation keeps same-category focus but an opposite category releases it", () => {
    const state: FixationState = {
      movesApplied: 1,
      focus: { category: "pawn", square: "e4" },
    };
    const samePawn = move("white", "e4", "e5", "pawn");
    const otherPawn = move("white", "a2", "a3", "pawn");
    const knight = move("white", "g1", "f3", "knight");
    expect(fixationRule.filterLegalMoves(
      moveContext(state),
      [samePawn, otherPawn, knight],
    )).toEqual([samePawn, knight]);
    expect(fixationRule.applyMove(
      transitionContext(state, BASE_FEN, BASE_FEN),
      knight,
    ).focus).toEqual({ category: "non-pawn", square: "f3" });
  });

  it("Fixation follows a promoted physical piece into the opposite category", () => {
    const promotedFocus: FixationState = {
      movesApplied: 1,
      focus: { category: "pawn", square: "a8" },
    };
    const promotedQueen = move("white", "a8", "b8", "queen");
    const otherQueen = move("white", "d1", "d2", "queen");
    expect(fixationRule.filterLegalMoves(
      moveContext(promotedFocus),
      [promotedQueen, otherQueen],
    )).toEqual([promotedQueen, otherQueen]);
  });

  it("Leveling Up unlocks capture targets in sequence", () => {
    const state: LevelingUpState = { movesApplied: 0, captureLevel: 0 };
    const quiet = move("white", "a2", "a3", "pawn");
    const pawn = move("white", "a2", "b3", "pawn", { captured: "pawn" });
    const knight = move("white", "a2", "b3", "pawn", {
      captured: "knight",
    });
    expect(levelingUpRule.filterLegalMoves(
      moveContext(state),
      [quiet, pawn, knight],
    )).toEqual([quiet, pawn]);
    const afterPawn = levelingUpRule.applyMove(
      transitionContext(state, BASE_FEN, BASE_FEN),
      pawn,
    );
    expect(afterPawn.captureLevel).toBe(1);
    expect(levelingUpRule.filterLegalMoves(
      moveContext(afterPawn),
      [pawn, knight],
    )).toEqual([pawn, knight]);
  });

  it("Leveling Up does not skip a frontier and reconstructs monotonic progress", () => {
    const history = [
      move("white", "a2", "b3", "pawn", { captured: "knight" }),
      move("white", "b3", "c4", "pawn", { captured: "pawn" }),
      move("white", "c4", "d5", "pawn", { captured: "knight" }),
    ];
    expect(levelingUpRule.initialize({
      color: "white",
      parameters: {},
      position: position(BASE_FEN, history),
    }).captureLevel).toBe(2);
  });

  it("Quicksand freezes a stationary middle-rank piece on the second snapshot", () => {
    const firstState: QuicksandState = {
      movesApplied: 1,
      previousMiddlePieces: ["rook@d4"],
      frozenPieces: [],
    };
    const quiet = move("white", "a2", "a3", "pawn");
    const next = quicksandRule.applyMove(
      transitionContext(
        firstState,
        "4k3/8/8/8/3R4/8/P7/4K3 w - - 0 1",
        "4k3/8/8/8/3R4/P7/8/4K3 b - - 0 1",
      ),
      quiet,
    );
    expect(next.frozenPieces).toContain("rook@d4");
    const frozenMove = move("white", "d4", "d5", "rook");
    expect(quicksandRule.filterLegalMoves(
      moveContext(
        next,
        "4k3/8/8/8/3R4/P7/8/4K3 w - - 0 2",
      ),
      [frozenMove],
    )).toEqual([]);
  });

  it("Quicksand does not freeze a mover that changes middle squares", () => {
    const state: QuicksandState = {
      movesApplied: 1,
      previousMiddlePieces: ["rook@d4"],
      frozenPieces: [],
    };
    const rookMove = move("white", "d4", "d5", "rook");
    const next = quicksandRule.applyMove(
      transitionContext(
        state,
        "4k3/8/8/8/3R4/8/8/4K3 w - - 0 1",
        "4k3/8/8/3R4/8/8/8/4K3 b - - 1 1",
      ),
      rookMove,
    );
    expect(next.frozenPieces).toEqual([]);
    expect(next.previousMiddlePieces).toEqual(["rook@d5"]);
  });

  it("Quicksand rejects castling when its auxiliary rook is frozen", () => {
    const state: QuicksandState = {
      movesApplied: 2,
      previousMiddlePieces: [],
      frozenPieces: ["rook@h1"],
    };
    const castle = move("white", "e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(quicksandRule.filterLegalMoves(
      moveContext(state, "4k3/8/8/8/8/8/8/4K2R w K - 0 1"),
      [castle],
    )).toEqual([]);
  });

  it("Absolution blocks a dirty non-bishop capture until a later adjacent start", () => {
    const state: AbsolutionState = {
      movesApplied: 1,
      dirtyPieces: [{ square: "d4", type: "rook" }],
    };
    const capture = move("white", "d4", "d5", "rook", {
      captured: "pawn",
    });
    const quiet = move("white", "d4", "d3", "rook");
    expect(absolutionRule.filterLegalMoves(
      moveContext(state, "4k3/8/8/8/3R4/8/8/4K3 w - - 0 1"),
      [capture, quiet],
    )).toEqual([quiet]);
    expect(absolutionRule.filterLegalMoves(
      moveContext(state, "4k3/8/8/8/3R4/2B5/8/4K3 w - - 0 1"),
      [capture],
    )).toEqual([capture]);
  });

  it("Absolution exempts bishops and marks capturing promoted pieces dirty", () => {
    const clean: AbsolutionState = { movesApplied: 0, dirtyPieces: [] };
    const bishopCapture = move("white", "c3", "d4", "bishop", {
      captured: "pawn",
    });
    expect(absolutionRule.applyMove(
      transitionContext(clean, BASE_FEN, BASE_FEN),
      bishopCapture,
    ).dirtyPieces).toEqual([]);

    const promotion = move("white", "a7", "b8", "pawn", {
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(absolutionRule.applyMove(
      transitionContext(clean, BASE_FEN, BASE_FEN),
      promotion,
    ).dirtyPieces).toEqual([{ square: "b8", type: "queen" }]);
  });

  it("Absolution keeps a capturing promotion to bishop dirty", () => {
    const clean: AbsolutionState = { movesApplied: 0, dirtyPieces: [] };
    const promotion = move("white", "a7", "b8", "pawn", {
      captured: "rook",
      promotion: "bishop",
      flags: "capture,promotion",
    });
    const dirty = absolutionRule.applyMove(
      transitionContext(clean, BASE_FEN, BASE_FEN),
      promotion,
    );
    const nextCapture = move("white", "b8", "c7", "bishop", {
      captured: "pawn",
    });
    expect(absolutionRule.filterLegalMoves(
      moveContext(dirty, "1B2k3/2p5/8/8/8/8/8/4K3 w - - 0 2"),
      [nextCapture],
    )).toEqual([]);
  });

  it("Absolution follows a dirty rook through castling", () => {
    const dirtyRook: AbsolutionState = {
      movesApplied: 1,
      dirtyPieces: [{ square: "h1", type: "rook" }],
    };
    const castle = move("white", "e1", "g1", "king", {
      flags: "kingside-castle",
    });
    const after = absolutionRule.applyMove(
      transitionContext(
        dirtyRook,
        "4k3/8/8/8/8/8/8/4K2R w K - 0 1",
        "4k3/8/8/8/8/8/8/5RK1 b - - 1 1",
      ),
      castle,
    );
    expect(after.dirtyPieces).toEqual([{ square: "f1", type: "rook" }]);
    const capture = move("white", "f1", "f7", "rook", {
      captured: "pawn",
    });
    expect(absolutionRule.filterLegalMoves(
      moveContext(after, "4k3/5p2/8/8/8/8/8/5RK1 w - - 0 2"),
      [capture],
    )).toEqual([]);
  });

  it("Moving Day loses at the twenty-turn boundary with any own home-rank piece", () => {
    const nineteen = Array.from(
      { length: 19 },
      (_, index) => move("white", "a2", "a3", "pawn", {
        flags: `quiet-${String(index)}`,
      }),
    );
    const contextBefore = moveContext(
      { movesApplied: 19 },
      "4k3/8/8/8/8/8/8/R3K3 w - - 0 20",
      nineteen,
    );
    expect(movingDayRule.checkStartOfTurnLoss(contextBefore)).toBeNull();
    const twenty = [...nineteen, move("white", "b2", "b3", "pawn")];
    expect(movingDayRule.checkStartOfTurnLoss(moveContext(
      { movesApplied: 20 },
      "4k3/8/8/8/8/8/8/R3K3 w - - 0 21",
      twenty,
    ))).toMatchObject({ ruleId: "moving-day", color: "white" });
  });

  it("Moving Day mirrors home rank and passes when it is empty", () => {
    const history = Array.from(
      { length: 20 },
      () => move("black", "a7", "a6", "pawn"),
    );
    expect(movingDayRule.checkStartOfTurnLoss(moveContext(
      { movesApplied: 20 },
      "4k2r/8/8/8/8/8/8/4K3 b - - 0 21",
      history,
      "black",
    ))).not.toBeNull();
    expect(movingDayRule.checkStartOfTurnLoss(moveContext(
      { movesApplied: 20 },
      "8/4k3/8/8/8/8/8/4K3 b - - 0 21",
      history,
      "black",
    ))).toBeNull();
  });

  it("Siege requires an own rook capture by the twenty-turn boundary", () => {
    const quietHistory = Array.from(
      { length: 20 },
      () => move("white", "a2", "a3", "pawn"),
    );
    expect(siegeRule.checkStartOfTurnLoss(moveContext(
      { movesApplied: 20 },
      BASE_FEN,
      quietHistory,
    ))).toMatchObject({ ruleId: "siege" });
    const success = [
      ...quietHistory.slice(0, 19),
      move("white", "a1", "a8", "rook", { captured: "rook" }),
    ];
    expect(siegeRule.checkStartOfTurnLoss(moveContext(
      { movesApplied: 20 },
      BASE_FEN,
      success,
    ))).toBeNull();
  });

  it("Siege ignores an opponent's rook capture", () => {
    const history = [
      ...Array.from(
        { length: 20 },
        () => move("white", "a2", "a3", "pawn"),
      ),
      move("black", "a8", "a1", "rook", { captured: "rook" }),
    ];
    expect(siegeRule.checkStartOfTurnLoss(moveContext(
      { movesApplied: 20 },
      BASE_FEN,
      history,
    ))).not.toBeNull();
  });
});
