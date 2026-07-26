import { describe, expect, it } from "vitest";
import type { ChessMove, PieceType, PositionView } from "../types.js";
import {
  friendlyFireRule,
  nowKissRule,
  protectedPawnsRule,
  queenDisguiseRule,
  remainingStatefulRules,
  risingWaterRule,
  rookOnTheSeventhRule,
  type NowKissState,
  type QueenDisguiseState,
  type RookOnTheSeventhState,
} from "./remaining-stateful-rules.js";

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

function context<State>(
  state: State,
  fen: string,
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

describe("remaining stateful rules", () => {
  it("has unique implemented-unverified metadata and immutable filtering", () => {
    expect(remainingStatefulRules).toHaveLength(6);
    expect(new Set(remainingStatefulRules.map(({ id }) => id)).size).toBe(6);
    expect(remainingStatefulRules.every(
      ({ verification }) => verification === "implemented-unverified",
    )).toBe(true);
  });

  it("Friendly Fire uses resulting-position defense and does not count self", () => {
    const rook = move("a1", "a2", "rook");
    expect(friendlyFireRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        "4k3/8/8/8/8/8/8/R3K3 w - - 0 1",
      ),
      [rook],
    )).toEqual([]);
    expect(friendlyFireRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        "4k3/8/8/8/8/8/8/RK6 w - - 0 1",
      ),
      [rook],
    )).toEqual([rook]);
  });

  it("Friendly Fire lets the castling rook defend the king destination", () => {
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(friendlyFireRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        "4k3/8/8/8/8/8/8/4K2R w K - 0 1",
      ),
      [castle],
    )).toEqual([castle]);
  });

  it("Protected Pawns restricts pawn movers including promotions only", () => {
    const pawn = move("a2", "a3", "pawn");
    const rook = move("h1", "h2", "rook");
    expect(protectedPawnsRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        "4k3/8/8/8/8/8/P7/4K2R w - - 0 1",
      ),
      [pawn, rook],
    )).toEqual([rook]);
    const promotion = move("a7", "a8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    expect(protectedPawnsRule.filterLegalMoves(
      context(
        { movesApplied: 0 },
        "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
      ),
      [promotion],
    )).toEqual([]);
  });

  it("Rook on the Seventh forces the deadline move and records achievement", () => {
    const state: RookOnTheSeventhState = {
      movesApplied: 14,
      achieved: false,
    };
    const target = move("a6", "a7", "rook");
    const other = move("e1", "e2", "king");
    expect(rookOnTheSeventhRule.filterLegalMoves(
      context(state, "4k3/8/R7/8/8/8/8/4K3 w - - 0 15"),
      [target, other],
    )).toEqual([target]);
    expect(rookOnTheSeventhRule.applyMove(
      {
        ...context(state, "4k3/8/R7/8/8/8/8/4K3 w - - 0 15"),
        positionAfterMove: position(
          "4k3/R7/8/8/8/8/8/4K3 b - - 1 15",
          [target],
          "black",
        ),
      },
      target,
    )).toEqual({ movesApplied: 15, achieved: true });
  });

  it("Rook on the Seventh mirrors Black and loses after a missed deadline", () => {
    const missed: RookOnTheSeventhState = {
      movesApplied: 15,
      achieved: false,
    };
    expect(rookOnTheSeventhRule.checkStartOfTurnLoss(context(
      missed,
      "4k3/8/8/8/8/8/r7/4K3 b - - 0 16",
      [],
      "black",
    ))).toMatchObject({ color: "black" });
    const deadline: RookOnTheSeventhState = {
      movesApplied: 14,
      achieved: false,
    };
    const target = move("a3", "a2", "rook", { color: "black" });
    expect(rookOnTheSeventhRule.filterLegalMoves(
      context(
        deadline,
        "4k3/8/8/8/8/r7/8/4K3 b - - 0 15",
        [],
        "black",
      ),
      [target],
    )).toEqual([target]);
  });

  it("Rising Water activates at exact ten-turn boundaries for both colors", () => {
    const rankOne = move("a1", "a2", "rook");
    const dry = move("a2", "a3", "rook");
    expect(risingWaterRule.filterLegalMoves(
      context({ movesApplied: 9 }, "4k3/8/8/8/8/8/R7/R3K3 w - - 0 10"),
      [rankOne, dry],
    )).toEqual([rankOne, dry]);
    expect(risingWaterRule.filterLegalMoves(
      context({ movesApplied: 10 }, "4k3/8/8/8/8/8/R7/R3K3 w - - 0 11"),
      [rankOne, dry],
    )).toEqual([dry]);
    const blackHome = move("a8", "a7", "rook", { color: "black" });
    expect(risingWaterRule.filterLegalMoves(
      context(
        { movesApplied: 10 },
        "r3k3/r7/8/8/8/8/8/4K3 b - - 0 11",
        [],
        "black",
      ),
      [blackHome],
    )).toEqual([]);
  });

  it("Queen Disguise locks the original queen to its first movement family", () => {
    const initial: QueenDisguiseState = {
      movesApplied: 0,
      trackedSquare: "d1",
      mode: null,
    };
    const diagonal = move("d1", "h5", "queen");
    const after = queenDisguiseRule.applyMove(
      {
        ...context(initial, "4k3/8/8/8/8/8/8/3QK3 w - - 0 1"),
        positionAfterMove: position(
          "4k3/8/8/7Q/8/8/8/4K3 b - - 1 1",
          [diagonal],
          "black",
        ),
      },
      diagonal,
    );
    expect(after).toEqual({
      movesApplied: 1,
      trackedSquare: "h5",
      mode: "bishop",
    });
    const bishopLike = move("h5", "g6", "queen");
    const rookLike = move("h5", "h6", "queen");
    expect(queenDisguiseRule.filterLegalMoves(
      context(after, "4k3/8/8/7Q/8/8/8/4K3 w - - 1 2"),
      [bishopLike, rookLike],
    )).toEqual([bishopLike]);
  });

  it("Queen Disguise does not transfer to a promoted replacement", () => {
    const stale: QueenDisguiseState = {
      movesApplied: 2,
      trackedSquare: "h5",
      mode: "bishop",
    };
    const replacement = move("a8", "a7", "queen");
    expect(queenDisguiseRule.filterLegalMoves(
      context(stale, "Q3k3/8/8/8/8/8/8/4K3 w - - 0 3"),
      [replacement],
    )).toEqual([replacement]);
  });

  it("Queen Disguise reconstructs a moved and returned original queen", () => {
    const out = move("d1", "d3", "queen");
    const back = move("d3", "d1", "queen");
    const state = queenDisguiseRule.initialize({
      color: "white",
      parameters: {},
      position: position(
        "4k3/8/8/8/8/8/8/3QK3 w - - 0 3",
        [out, back],
      ),
    });
    expect(state).toEqual({
      movesApplied: 2,
      trackedSquare: "d1",
      mode: "rook",
    });
    const orthogonal = move("d1", "d2", "queen");
    const diagonal = move("d1", "h5", "queen");
    expect(queenDisguiseRule.filterLegalMoves(
      context(state, "4k3/8/8/8/8/8/8/3QK3 w - - 0 3"),
      [orthogonal, diagonal],
    )).toEqual([orthogonal]);
  });

  it("Now Kiss blocks family captures until an adjacent pair ends a turn", () => {
    const locked: NowKissState = { movesApplied: 0, unlockedTypes: [] };
    const capture = move("c1", "h6", "bishop", { captured: "pawn" });
    const quiet = move("c1", "d2", "bishop");
    expect(nowKissRule.filterLegalMoves(
      context(locked, "4k3/7p/8/8/8/8/8/2B1K3 w - - 0 1"),
      [capture, quiet],
    )).toEqual([quiet]);
  });

  it("Now Kiss unlocks each family permanently from the resulting board", () => {
    const locked: NowKissState = { movesApplied: 0, unlockedTypes: [] };
    const approach = move("c3", "d4", "bishop");
    const after = nowKissRule.applyMove(
      {
        ...context(
          locked,
          "4k3/8/8/4B3/8/2B5/8/4K3 w - - 0 1",
        ),
        positionAfterMove: position(
          "4k3/8/8/4B3/3B4/8/8/4K3 b - - 1 1",
          [approach],
          "black",
        ),
      },
      approach,
    );
    expect(after.unlockedTypes).toEqual(["bishop"]);
    const capture = move("d4", "e5", "bishop", { captured: "pawn" });
    expect(nowKissRule.filterLegalMoves(
      context(after, "4k3/8/8/4p3/3B4/8/8/4K3 w - - 0 2"),
      [capture],
    )).toEqual([capture]);
  });

  it("Now Kiss counts imported own moves but requires persisted unlock state", () => {
    const own = move("b1", "c3", "knight");
    const opponent = move("b8", "c6", "knight", { color: "black" });
    expect(nowKissRule.initialize({
      color: "white",
      parameters: {},
      position: position(
        "4k3/8/8/8/8/2N5/8/4K3 w - - 0 2",
        [own, opponent],
      ),
    })).toEqual({ movesApplied: 1, unlockedTypes: [] });
  });
});
