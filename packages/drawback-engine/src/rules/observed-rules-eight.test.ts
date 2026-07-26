import { describe, expect, it } from "vitest";
import type { ChessMove, PieceType, PositionView } from "../types.js";
import {
  bishopFanClubRule,
  blindedByTheSunRule,
  fischerRandomRule,
  observedRulesEight,
  respectfulRule,
  rookFanClubRule,
  shapeshifterRule,
  unspoolingRule,
  type ShapeshifterState,
  type UnspoolingState,
} from "./observed-rules-eight.js";

function move(
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly color?: ChessMove["color"];
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
    san: `${from}-${to}`,
    flags: options.flags ??
      (options.captured === undefined ? "quiet" : "capture"),
    ...(options.captured === undefined ? {} : { captured: options.captured }),
    ...(options.promotion === undefined ? {} : { promotion: options.promotion }),
  };
}

function position(
  fen: string,
  history: readonly ChessMove[] = [],
  turn: ChessMove["color"] = "white",
): PositionView {
  return { fen, history, turn, ply: history.length };
}

function context<State, Parameters>(
  state: State,
  parameters: Parameters,
  fen: string,
  history: readonly ChessMove[] = [],
  color: ChessMove["color"] = "white",
) {
  return {
    color,
    parameters,
    state,
    position: position(fen, history, color),
  };
}

describe("observed rules wave eight", () => {
  it("contains seven unique implemented-unverified rules", () => {
    expect(observedRulesEight).toHaveLength(7);
    expect(new Set(observedRulesEight.map(({ id }) => id)).size).toBe(7);
    expect(observedRulesEight.every(
      ({ verification }) => verification === "implemented-unverified",
    )).toBe(true);
  });

  it("Bishop Fan Club restricts promotion and royal geometry", () => {
    const bishopPromotion = move("a7", "a8", "pawn", {
      promotion: "bishop",
      flags: "promotion",
    });
    const queenPromotion = move("a7", "a8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    const diagonalQueen = move("d1", "h5", "queen");
    const straightQueen = move("d1", "d3", "queen");
    const diagonalKing = move("e1", "f2", "king");
    const straightKing = move("e1", "e2", "king");
    expect(bishopFanClubRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        {},
        "4k3/P7/8/8/8/8/8/3QK3 w - - 0 1",
      ),
      [
        bishopPromotion,
        queenPromotion,
        diagonalQueen,
        straightQueen,
        diagonalKing,
        straightKing,
      ],
    )).toEqual([bishopPromotion, diagonalQueen, diagonalKing]);
  });

  it("Bishop Fan Club rejects castling while Rook Fan Club permits it", () => {
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    const rookPromotion = move("a7", "a8", "pawn", {
      promotion: "rook",
      flags: "promotion",
    });
    const bishopPromotion = move("a7", "a8", "pawn", {
      promotion: "bishop",
      flags: "promotion",
    });
    const diagonalQueen = move("d1", "h5", "queen");
    expect(bishopFanClubRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        {},
        "4k3/P7/8/8/8/8/8/3QK2R w K - 0 1",
      ),
      [castle],
    )).toEqual([]);
    expect(rookFanClubRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        {},
        "4k3/P7/8/8/8/8/8/3QK2R w K - 0 1",
      ),
      [castle, rookPromotion, bishopPromotion, diagonalQueen],
    )).toEqual([castle, rookPromotion]);
  });

  it("applies Fan Club restrictions to Black as well", () => {
    const diagonal = move("d8", "h4", "queen", { color: "black" });
    const orthogonal = move("d8", "d6", "queen", { color: "black" });
    expect(bishopFanClubRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        {},
        "3qk3/8/8/8/8/8/8/4K3 b - - 0 1",
        [],
        "black",
      ),
      [diagonal, orthogonal],
    )).toEqual([diagonal]);
  });

  it("Respectful rejects direct checks and preserves quiet moves", () => {
    const check = move("a1", "a8", "rook");
    const quiet = move("a1", "b1", "rook");
    expect(respectfulRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        {},
        "7k/8/8/8/8/8/8/R3K3 w - - 0 1",
      ),
      [check, quiet],
    )).toEqual([quiet]);
  });

  it("Respectful recognizes promotion and castling checks after projection", () => {
    const promotionCheck = move("b7", "b8", "pawn", {
      promotion: "rook",
      flags: "promotion",
    });
    const castleCheck = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(respectfulRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        {},
        "8/1P6/1k6/8/8/8/8/4K3 w - - 0 1",
      ),
      [promotionCheck],
    )).toEqual([]);
    expect(respectfulRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        {},
        "5k2/8/8/8/8/8/8/4K2R w K - 0 1",
      ),
      [castleCheck],
    )).toEqual([]);
  });

  it("Shapeshifter begins bishop-like", () => {
    const initial: ShapeshifterState = {
      movesApplied: 0,
      trackedSquare: "d1",
      mode: "bishop",
    };
    const diagonal = move("d1", "h5", "queen");
    const orthogonal = move("d1", "d4", "queen");
    expect(shapeshifterRule.filterLegalMoves(
      context(
        initial,
        {},
        "4k3/8/8/8/8/8/8/3QK3 w - - 0 1",
      ),
      [diagonal, orthogonal],
    )).toEqual([diagonal]);
  });

  it("Shapeshifter copies a non-pawn captured by any own piece", () => {
    const initial: ShapeshifterState = {
      movesApplied: 0,
      trackedSquare: "d1",
      mode: "bishop",
    };
    const capture = move("a1", "a8", "rook", {
      captured: "rook",
    });
    expect(shapeshifterRule.applyMove(
      {
        ...context(
          initial,
          {},
          "r3k3/8/8/8/8/8/8/R2QK3 w - - 0 1",
        ),
        positionAfterMove: position(
          "R3k3/8/8/8/8/8/8/3QK3 b - - 0 1",
          [capture],
          "black",
        ),
      },
      capture,
    )).toEqual({
      movesApplied: 1,
      trackedSquare: "d1",
      mode: "rook",
    });
  });

  it("Shapeshifter freezes after a knight capture and ignores pawn captures", () => {
    const frozen: ShapeshifterState = {
      movesApplied: 2,
      trackedSquare: "d1",
      mode: "frozen",
    };
    const queenMove = move("d1", "h5", "queen");
    const pawnMove = move("a2", "b3", "pawn", { captured: "pawn" });
    expect(shapeshifterRule.filterLegalMoves(
      context(
        frozen,
        {},
        "4k3/8/8/8/8/8/P7/3QK3 w - - 0 3",
      ),
      [queenMove, pawnMove],
    )).toEqual([pawnMove]);
    expect(shapeshifterRule.applyMove(
      {
        ...context(
          frozen,
          {},
          "4k3/8/8/8/8/1p6/P7/3QK3 w - - 0 3",
        ),
        positionAfterMove: position(
          "4k3/8/8/8/8/1P6/8/3QK3 b - - 0 3",
          [pawnMove],
          "black",
        ),
      },
      pawnMove,
    ).mode).toBe("frozen");
  });

  it("Shapeshifter reconstructs mode and original-queen identity", () => {
    const queenOut = move("d1", "h5", "queen");
    const capture = move("a1", "a8", "rook", { captured: "rook" });
    expect(shapeshifterRule.initialize({
      color: "white",
      parameters: {},
      position: position(
        "R3k3/8/8/7Q/8/8/8/4K3 w - - 0 3",
        [queenOut, capture],
      ),
    })).toEqual({
      movesApplied: 2,
      trackedSquare: "h5",
      mode: "rook",
    });
  });

  it("Shapeshifter drops a captured original queen without restricting replacements", () => {
    const queenOut = move("d1", "h5", "queen");
    const queenCaptured = move("g6", "h5", "bishop", {
      color: "black",
      captured: "queen",
    });
    const state = shapeshifterRule.initialize({
      color: "white",
      parameters: {},
      position: position(
        "Q3k3/8/8/8/8/8/8/4K3 w - - 0 2",
        [queenOut, queenCaptured],
      ),
    });
    expect(state.trackedSquare).toBeNull();
    const replacementMove = move("a8", "a7", "queen");
    expect(shapeshifterRule.filterLegalMoves(
      context(
        state,
        {},
        "Q3k3/8/8/8/8/8/8/4K3 w - - 0 2",
      ),
      [replacementMove],
    )).toEqual([replacementMove]);
  });

  it("Fischer Random forces a valid full arrangement on turn twenty", () => {
    const keepHome = move("d1", "c1", "king");
    const leaveHome = move("d1", "d2", "king");
    expect(fischerRandomRule.filterLegalMoves(
      context(
        { movesApplied: 19 },
        {},
        "4k3/8/8/8/8/8/8/3K4 w - - 0 20",
      ),
      [keepHome, leaveHome],
    )).toEqual([keepHome]);
  });

  it("Fischer Random mirrors Black and reports missed arrangements", () => {
    expect(fischerRandomRule.checkStartOfTurnLoss(
      context(
        { movesApplied: 20 },
        {},
        "4k3/8/8/8/8/8/8/4K3 w - - 0 21",
      ),
    )).toMatchObject({ ruleId: "fischer-random", color: "white" });
    expect(fischerRandomRule.checkStartOfTurnLoss(
      context(
        { movesApplied: 20 },
        {},
        "3k4/8/8/8/8/8/8/4K3 b - - 0 21",
        [],
        "black",
      ),
    )).toBeNull();
  });

  it("Fischer Random evaluates promoted pieces by their current type", () => {
    const rookStaysInvalid = move("a1", "a2", "rook");
    expect(fischerRandomRule.filterLegalMoves(
      context(
        { movesApplied: 19 },
        {},
        "4k3/8/8/8/8/8/8/R2K4 w - - 0 20",
      ),
      [rookStaysInvalid],
    )).toEqual([]);
  });

  it("Fischer Random is unrestricted before the deadline and preserved after it", () => {
    const leaveHome = move("d1", "d2", "king");
    expect(fischerRandomRule.filterLegalMoves(
      context(
        { movesApplied: 18 },
        {},
        "4k3/8/8/8/8/8/8/3K4 w - - 0 19",
      ),
      [leaveHome],
    )).toEqual([leaveHome]);
    expect(fischerRandomRule.filterLegalMoves(
      context(
        { movesApplied: 20 },
        {},
        "4k3/8/8/8/8/8/8/3K4 w - - 0 21",
      ),
      [leaveHome],
    )).toEqual([]);
  });

  it("Fischer Random projects both castling pieces and actual promotions", () => {
    const castle = move("e1", "c1", "king", {
      flags: "queenside-castle",
    });
    expect(fischerRandomRule.filterLegalMoves(
      context(
        { movesApplied: 19 },
        {},
        "4k3/8/8/8/8/8/8/R3K3 w Q - 0 20",
      ),
      [castle],
    )).toEqual([castle]);
    const promotion = move("b7", "b8", "pawn", {
      promotion: "rook",
      flags: "promotion",
    });
    expect(fischerRandomRule.filterLegalMoves(
      context(
        { movesApplied: 19 },
        {},
        "4k3/1P6/8/8/8/8/8/3K4 w - - 0 20",
      ),
      [promotion],
    )).toEqual([]);
  });

  it("Unspooling reconstructs and enforces the Manhattan budget", () => {
    const prior = move("a1", "h8", "queen");
    const state = unspoolingRule.initialize({
      color: "white",
      parameters: {},
      position: position(
        "4k2Q/8/8/8/8/8/8/4K3 w - - 0 2",
        [prior],
      ),
    });
    expect(state).toEqual({ movesApplied: 1, distanceUsed: 14 });
    const affordable = move("a1", "a2", "rook");
    const tooFar = move("a1", "h8", "queen");
    const nearLimit: UnspoolingState = {
      movesApplied: 20,
      distanceUsed: 99,
    };
    expect(unspoolingRule.filterLegalMoves(
      context(
        nearLimit,
        {},
        "4k3/8/8/8/8/8/8/R3K3 w - - 0 21",
      ),
      [affordable, tooFar],
    )).toEqual([affordable]);
  });

  it("Unspooling allows the final unit then loses next affected turn", () => {
    const finalMove = move("a1", "a2", "rook");
    const before: UnspoolingState = {
      movesApplied: 20,
      distanceUsed: 99,
    };
    const after = unspoolingRule.applyMove(
      {
        ...context(
          before,
          {},
          "4k3/8/8/8/8/8/8/R3K3 w - - 0 21",
        ),
        positionAfterMove: position(
          "4k3/8/8/8/8/8/R7/4K3 b - - 0 21",
          [finalMove],
          "black",
        ),
      },
      finalMove,
    );
    expect(after.distanceUsed).toBe(100);
    expect(unspoolingRule.checkStartOfTurnLoss(
      context(after, {}, "4k3/8/8/8/8/8/R7/4K3 w - - 0 22"),
    )).toMatchObject({ ruleId: "unspooling" });
  });

  it("Unspooling charges castling by the primary king endpoints", () => {
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(unspoolingRule.applyMove(
      {
        ...context(
          { movesApplied: 10, distanceUsed: 97 },
          {},
          "4k3/8/8/8/8/8/8/4K2R w K - 0 11",
        ),
        positionAfterMove: position(
          "4k3/8/8/8/8/8/8/5RK1 b - - 1 11",
          [castle],
          "black",
        ),
      },
      castle,
    ).distanceUsed).toBe(99);
  });

  it("Blinded by the Sun rejects resulting attacks on its hidden square", () => {
    const attacks = move("d1", "d2", "rook");
    const safe = move("d1", "c1", "rook");
    expect(blindedByTheSunRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        { square: "d4" },
        "4k3/8/8/8/8/8/8/3RK3 w - - 0 1",
      ),
      [attacks, safe],
    )).toEqual([safe]);
  });

  it("Blinded by the Sun accounts for promoted and castling pieces", () => {
    const promotionAttack = move("b7", "b8", "pawn", {
      promotion: "bishop",
      flags: "promotion",
    });
    const castleAttack = move("e1", "c1", "king", {
      flags: "queenside-castle",
    });
    expect(blindedByTheSunRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        { square: "e5" },
        "4k3/1P6/8/8/8/8/8/4K3 w - - 0 1",
      ),
      [promotionAttack],
    )).toEqual([]);
    expect(blindedByTheSunRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        { square: "d4" },
        "4k3/8/8/8/8/8/8/R3K3 w Q - 0 1",
      ),
      [castleAttack],
    )).toEqual([]);
  });
});
