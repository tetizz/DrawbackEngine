import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  PromotionPiece,
  RuleMoveContext,
  RuleTransitionContext,
} from "../types.js";
import type { NoParameters } from "./common.js";
import {
  battleFatigueRule,
  type BattleFatigueState,
} from "./battle-fatigue.js";
import {
  barbarianRageRule,
  type BarbarianRageState,
} from "./barbarian-rage.js";
import {
  eyeForAnEyeRule,
  type EyeForAnEyeState,
} from "./eye-for-an-eye.js";
import {
  quitHorsingAroundRule,
  type QuitHorsingAroundState,
} from "./quit-horsing-around.js";
import { remorsefulRule, type RemorsefulState } from "./remorseful.js";

interface MoveInput {
  readonly from: string;
  readonly to: string;
  readonly color?: "white" | "black";
  readonly piece: PieceType;
  readonly captured?: PieceType;
  readonly promotion?: PromotionPiece;
  readonly flags?: string;
  readonly san?: string;
}

function move(input: MoveInput): ChessMove {
  return {
    from: input.from,
    to: input.to,
    color: input.color ?? "white",
    piece: input.piece,
    ...(input.captured === undefined ? {} : { captured: input.captured }),
    ...(input.promotion === undefined ? {} : { promotion: input.promotion }),
    san: input.san ?? `${input.from}-${input.to}`,
    flags: input.flags ?? (input.captured === undefined ? "quiet" : "capture"),
  };
}

function context<State>(
  state: State,
  history: readonly ChessMove[] = [],
  fen = "8/8/8/8/8/8/8/4K3 w - - 0 1",
): RuleMoveContext<State, NoParameters> {
  return {
    color: "white",
    parameters: {},
    state,
    position: { fen, turn: "white", ply: history.length, history },
  };
}

function transition<State>(
  state: State,
  fen: string,
  history: readonly ChessMove[] = [],
): RuleTransitionContext<State, NoParameters> {
  return {
    ...context(state, history, fen),
    positionAfterMove: {
      fen,
      turn: "black",
      ply: history.length + 1,
      history,
    },
  };
}

const quietPawn = move({ from: "e2", to: "e3", piece: "pawn" });
const knightMove = move({ from: "g1", to: "f3", piece: "knight" });
const capture = move({
  from: "e4",
  to: "d5",
  piece: "pawn",
  captured: "pawn",
});
const enPassant = move({
  from: "e5",
  to: "d6",
  piece: "pawn",
  captured: "pawn",
  flags: "capture,en-passant",
});
const castle = move({
  from: "e1",
  to: "g1",
  piece: "king",
  flags: "quiet,kingside-castle",
});

describe("Quit Horsing Around", () => {
  it("blocks every knight after a knight move and clears after another mover", () => {
    const restricted: QuitHorsingAroundState = { previousMoveWasKnight: true };
    expect(
      quitHorsingAroundRule.filterLegalMoves(
        context(restricted),
        [knightMove, quietPawn],
      ),
    ).toEqual([quietPawn]);
    expect(
      quitHorsingAroundRule.applyMove(
        transition(restricted, "8/8/8/8/8/8/4P3/4K1N1 w - - 0 1"),
        quietPawn,
      ),
    ).toEqual({ previousMoveWasKnight: false });
  });

  it("treats promotion to knight as a pawn move and castling as king move", () => {
    const restricted: QuitHorsingAroundState = { previousMoveWasKnight: true };
    const promotion = move({
      from: "a7",
      to: "a8",
      piece: "pawn",
      promotion: "knight",
      flags: "quiet,promotion",
    });
    expect(
      quitHorsingAroundRule.applyMove(
        transition(restricted, "8/P7/8/8/8/8/8/4K3 w - - 0 1"),
        promotion,
      ).previousMoveWasKnight,
    ).toBe(false);
    expect(
      quitHorsingAroundRule.applyMove(
        transition(restricted, "8/8/8/8/8/8/8/4K2R w K - 0 1"),
        castle,
      ).previousMoveWasKnight,
    ).toBe(false);
  });
});

describe("Remorseful", () => {
  it("forbids captures after a capture, including en-passant and promotion", () => {
    const state: RemorsefulState = { previousMoveWasCapture: true };
    const capturingPromotion = move({
      from: "g7",
      to: "h8",
      piece: "pawn",
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(
      remorsefulRule.filterLegalMoves(
        context(state),
        [quietPawn, enPassant, capturingPromotion],
      ),
    ).toEqual([quietPawn]);
  });

  it("sets state for en-passant and clears it for castling", () => {
    const clear: RemorsefulState = { previousMoveWasCapture: false };
    const captured = remorsefulRule.applyMove(
      transition(clear, "8/8/8/3pP3/8/8/8/4K3 w - d6 0 1"),
      enPassant,
    );
    expect(captured.previousMoveWasCapture).toBe(true);
    expect(
      remorsefulRule.applyMove(
        transition(captured, "8/8/8/8/8/8/8/4K2R w K - 0 1"),
        castle,
      ).previousMoveWasCapture,
    ).toBe(false);
  });
});

describe("Barbarian Rage", () => {
  const enraged: BarbarianRageState = { previousMoveWasCapture: true };

  it("forces every available capture, including en-passant", () => {
    expect(
      barbarianRageRule.filterLegalMoves(
        context(enraged),
        [quietPawn, capture, enPassant],
      ),
    ).toEqual([capture, enPassant]);
  });

  it("allows all moves if no capture is available and quiet moves clear rage", () => {
    expect(
      barbarianRageRule.filterLegalMoves(
        context(enraged),
        [quietPawn, knightMove],
      ),
    ).toEqual([quietPawn, knightMove]);
    expect(
      barbarianRageRule.applyMove(
        transition(enraged, "8/8/8/8/8/8/4P3/4K1N1 w - - 0 1"),
        castle,
      ).previousMoveWasCapture,
    ).toBe(false);
  });
});

describe("Eye for an Eye", () => {
  const state: EyeForAnEyeState = { movesApplied: 0 };
  const opponentCapture = move({
    color: "black",
    from: "d5",
    to: "e4",
    piece: "pawn",
    captured: "pawn",
  });

  it("uses opponent history to force all and only legal captures", () => {
    expect(
      eyeForAnEyeRule.filterLegalMoves(
        context(state, [opponentCapture]),
        [quietPawn, capture, enPassant],
      ),
    ).toEqual([capture, enPassant]);
  });

  it("returns an empty set for an unsatisfied obligation, causing exact session loss", () => {
    expect(
      eyeForAnEyeRule.filterLegalMoves(
        context(state, [opponentCapture]),
        [quietPawn, knightMove, castle],
      ),
    ).toEqual([]);
  });

  it("does not create an obligation after an opponent quiet move", () => {
    const opponentQuiet = move({
      color: "black",
      from: "e7",
      to: "e6",
      piece: "pawn",
    });
    expect(
      eyeForAnEyeRule.filterLegalMoves(
        context(state, [opponentQuiet]),
        [quietPawn, knightMove],
      ),
    ).toEqual([quietPawn, knightMove]);
  });
});

describe("Battle Fatigue", () => {
  it("fatigues a capturing piece until that same identity moves quietly", () => {
    const fen = "4k3/8/8/8/8/8/R7/4K3 w - - 0 1";
    const initial = battleFatigueRule.initialize({
      color: "white",
      parameters: {},
      position: { fen, turn: "white", ply: 0, history: [] },
    });
    const rookCapture = move({
      from: "a2",
      to: "a8",
      piece: "rook",
      captured: "rook",
    });
    const tired = battleFatigueRule.applyMove(
      transition(initial, fen),
      rookCapture,
    );
    const secondCapture = move({
      from: "a8",
      to: "e8",
      piece: "rook",
      captured: "king",
    });
    expect(
      battleFatigueRule.filterLegalMoves(
        context(tired, [], "R3k3/8/8/8/8/8/8/4K3 w - - 0 1"),
        [secondCapture],
      ),
    ).toEqual([]);

    const quiet = move({ from: "a8", to: "a7", piece: "rook" });
    const rested = battleFatigueRule.applyMove(
      transition(tired, "R3k3/8/8/8/8/8/8/4K3 w - - 0 1"),
      quiet,
    );
    expect(rested.fatiguedIds).toEqual([]);
  });

  it("drops captured identities so a later piece on the stale square is fresh", () => {
    const fen = "4k3/8/8/8/8/8/8/R3K2R w - - 0 1";
    const initial = battleFatigueRule.initialize({
      color: "white",
      parameters: {},
      position: { fen, turn: "white", ply: 0, history: [] },
    });
    const tired = battleFatigueRule.applyMove(
      transition(initial, fen),
      move({ from: "a1", to: "a8", piece: "rook", captured: "rook" }),
    );
    const afterOpponentCaptured = "4k3/8/8/8/8/8/8/4K2R w - - 0 1";
    const relocated = battleFatigueRule.applyMove(
      transition(tired, afterOpponentCaptured),
      move({ from: "h1", to: "a1", piece: "rook" }),
    );
    const freshCapture = move({
      from: "a1",
      to: "a8",
      piece: "rook",
      captured: "rook",
    });
    expect(
      battleFatigueRule.filterLegalMoves(
        context(relocated, [], "4k3/8/8/8/8/8/8/R3K3 w - - 0 1"),
        [freshCapture],
      ),
    ).toEqual([freshCapture]);
  });

  it("preserves identity through capturing promotion", () => {
    const fen = "1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const initial = battleFatigueRule.initialize({
      color: "white",
      parameters: {},
      position: { fen, turn: "white", ply: 0, history: [] },
    });
    const promoted = battleFatigueRule.applyMove(
      transition(initial, fen),
      move({
        from: "a7",
        to: "b8",
        piece: "pawn",
        captured: "rook",
        promotion: "queen",
        flags: "capture,promotion",
      }),
    );
    const queenCapture = move({
      from: "b8",
      to: "e8",
      piece: "queen",
      captured: "king",
    });
    expect(
      battleFatigueRule.filterLegalMoves(
        context(promoted, [], "1Q2k3/8/8/8/8/8/8/4K3 w - - 0 1"),
        [queenCapture],
      ),
    ).toEqual([]);
  });

  it("moves both castling identities but clears fatigue only for the king", () => {
    const fen = "4k3/8/8/8/8/8/8/4K2R w K - 0 1";
    const initial = battleFatigueRule.initialize({
      color: "white",
      parameters: {},
      position: { fen, turn: "white", ply: 0, history: [] },
    });
    const kingId = initial.pieces.find((piece) => piece.square === "e1")?.id;
    const rookId = initial.pieces.find((piece) => piece.square === "h1")?.id;
    expect(kingId).toBeDefined();
    expect(rookId).toBeDefined();
    const tired: BattleFatigueState = {
      ...initial,
      fatiguedIds: [kingId ?? "", rookId ?? ""],
    };
    const castled = battleFatigueRule.applyMove(transition(tired, fen), castle);
    expect(castled.pieces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: kingId, square: "g1" }),
        expect.objectContaining({ id: rookId, square: "f1" }),
      ]),
    );
    expect(castled.fatiguedIds).toEqual([rookId]);
  });
});
