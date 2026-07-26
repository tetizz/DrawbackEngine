import { describe, expect, it } from "vitest";
import type { ChessMove, PieceType } from "../types.js";
import {
  attackObservedRules,
  deerInTheHeadlightsRule,
  helicopterParentRule,
  jumpyRule,
  medusaRule,
  paranoidRule,
  rookBuddiesRule,
  standYourGroundRule,
  unrequitedLoveRule,
  type RookBuddiesState,
} from "./attack-observed-rules.js";

function move(
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly color?: ChessMove["color"];
    readonly captured?: PieceType;
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
  };
}

function context<State>(
  state: State,
  fen: string,
  color: ChessMove["color"] = "white",
) {
  return {
    color,
    parameters: {},
    state,
    position: { fen, turn: color, ply: 0, history: [] },
  };
}

const STATE = { movesApplied: 0 };

describe("attack observed rules", () => {
  it("has unique implemented-unverified metadata and immutable filters", () => {
    expect(attackObservedRules).toHaveLength(8);
    expect(new Set(attackObservedRules.map(({ id }) => id)).size).toBe(8);
    expect(attackObservedRules.every(
      ({ verification }) => verification === "implemented-unverified",
    )).toBe(true);
    const candidate = Object.freeze(move("a2", "a3", "pawn"));
    const ordinary = Object.freeze([candidate]);
    for (const rule of attackObservedRules) {
      const position = {
        fen: "4k3/8/8/8/8/8/P7/R3K3 w - - 0 1",
        turn: "white" as const,
        ply: 0,
        history: [],
      };
      const result = rule.filterLegalMoves(
        {
          color: "white",
          parameters: {},
          state: rule.initialize({
            color: "white",
            parameters: {},
            position,
          }) as Readonly<unknown>,
          position,
        },
        ordinary,
      );
      expect(result).not.toBe(ordinary);
    }
  });

  it("Deer in the Headlights freezes attacked primary origins", () => {
    const fen = "r3k3/8/8/8/8/2N5/R7/4K3 w - - 0 1";
    const attacked = move("a2", "a3", "rook");
    const safe = move("c3", "b5", "knight");
    expect(deerInTheHeadlightsRule.filterLegalMoves(
      context(STATE, fen),
      [attacked, safe],
    )).toEqual([safe]);
  });

  it("Jumpy forces attacked movers and otherwise falls back", () => {
    const fen = "r3k3/8/8/8/8/2N5/R7/4K3 w - - 0 1";
    const attackedOne = move("a2", "a3", "rook");
    const attackedTwo = move("a2", "a4", "rook");
    const safe = move("c3", "b5", "knight");
    expect(jumpyRule.filterLegalMoves(
      context(STATE, fen),
      [attackedOne, attackedTwo, safe],
    )).toEqual([attackedOne, attackedTwo]);
    expect(jumpyRule.filterLegalMoves(
      context(STATE, fen),
      [safe],
    )).toEqual([safe]);
  });

  it("Medusa freezes queen rays but not identical rook rays", () => {
    const target = move("a2", "a3", "rook");
    expect(medusaRule.filterLegalMoves(
      context(STATE, "q3k3/8/8/8/8/8/R7/4K3 w - - 0 1"),
      [target],
    )).toEqual([]);
    expect(medusaRule.filterLegalMoves(
      context(STATE, "r3k3/8/8/8/8/8/R7/4K3 w - - 0 1"),
      [target],
    )).toEqual([target]);
  });

  it("Medusa respects blockers on a queen ray", () => {
    const target = move("a2", "b2", "rook");
    expect(medusaRule.filterLegalMoves(
      context(STATE, "q3k3/8/8/8/p7/8/R7/4K3 w - - 0 1"),
      [target],
    )).toEqual([target]);
  });

  it("Stand Your Ground restricts captures but never quiet moves", () => {
    const fen = "r3k3/8/8/8/8/2N5/R6p/4K3 w - - 0 1";
    const attackedCapture = move("a2", "h2", "rook", { captured: "pawn" });
    const safeCapture = move("c3", "b5", "knight", { captured: "pawn" });
    const quiet = move("c3", "d5", "knight");
    expect(standYourGroundRule.filterLegalMoves(
      context(STATE, fen),
      [attackedCapture, safeCapture, quiet],
    )).toEqual([attackedCapture, quiet]);
  });

  it("Unrequited Love constrains only king and queen movers", () => {
    const fen = "4k3/8/8/8/8/8/P7/3QK3 w - - 0 1";
    const kingEqual = move("e1", "d2", "king");
    const kingAway = move("e1", "f2", "king");
    const queenAway = move("d1", "d3", "queen");
    const queenEqual = move("d1", "e2", "queen");
    const pawn = move("a2", "a3", "pawn");
    expect(unrequitedLoveRule.filterLegalMoves(
      context(STATE, fen),
      [kingEqual, kingAway, queenAway, queenEqual, pawn],
    )).toEqual([kingEqual, queenAway, queenEqual, pawn]);
  });

  it("Unrequited Love freezes a king without an own queen", () => {
    const king = move("e1", "e2", "king");
    const pawn = move("a2", "a3", "pawn");
    expect(unrequitedLoveRule.filterLegalMoves(
      context(STATE, "4k3/8/8/8/8/8/P7/4K3 w - - 0 1"),
      [king, pawn],
    )).toEqual([pawn]);
  });

  it("Unrequited Love uses the nearest of multiple own queens", () => {
    const fen = "Q3k3/8/8/8/8/8/5Q2/4K3 w - - 0 1";
    const staysNearSecond = move("e1", "e2", "king");
    expect(unrequitedLoveRule.filterLegalMoves(
      context(STATE, fen),
      [staysNearSecond],
    )).toEqual([staysNearSecond]);
  });

  it("Helicopter Parent loses on an undefended pawn but not with no pawns", () => {
    expect(helicopterParentRule.checkStartOfTurnLoss(context(
      STATE,
      "4k3/8/8/8/P7/8/8/4K3 w - - 0 1",
    ))).toMatchObject({ ruleId: "helicopter-parent" });
    expect(helicopterParentRule.checkStartOfTurnLoss(context(
      STATE,
      "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
    ))).toBeNull();
    expect(helicopterParentRule.checkStartOfTurnLoss(context(
      STATE,
      "4k3/8/8/8/8/8/3P4/3RK3 w - - 0 1",
    ))).toBeNull();
  });

  it("Paranoid requires an own pseudo-defender of the king", () => {
    expect(paranoidRule.checkStartOfTurnLoss(context(
      STATE,
      "4k3/8/8/8/8/8/4R3/4K3 w - - 0 1",
    ))).toBeNull();
    expect(paranoidRule.checkStartOfTurnLoss(context(
      STATE,
      "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
    ))).toMatchObject({ ruleId: "paranoid" });
  });

  it("Rook Buddies locks rooks and castling until connected", () => {
    const locked: RookBuddiesState = {
      movesApplied: 0,
      connectedEver: false,
    };
    const rook = move("a1", "a2", "rook");
    const castle = move("e1", "g1", "king", { flags: "kingside-castle" });
    const bishop = move("c1", "d2", "bishop");
    expect(rookBuddiesRule.filterLegalMoves(
      context(locked, "4k3/8/8/8/8/8/8/R1B1K2R w KQ - 0 1"),
      [rook, castle, bishop],
    )).toEqual([bishop]);
  });

  it("Rook Buddies unlocks permanently from the resulting position", () => {
    const locked: RookBuddiesState = {
      movesApplied: 0,
      connectedEver: false,
    };
    const clear = move("a4", "b4", "queen");
    const after = rookBuddiesRule.applyMove(
      {
        ...context(locked, "R3k3/8/8/8/Q7/8/8/R3K3 w - - 0 1"),
        positionAfterMove: {
          fen: "R3k3/8/8/8/1Q6/8/8/R3K3 b - - 1 1",
          turn: "black",
          ply: 1,
          history: [clear],
        },
      },
      clear,
    );
    expect(after.connectedEver).toBe(true);
    const rook = move("a1", "a2", "rook");
    expect(rookBuddiesRule.filterLegalMoves(
      context(after, "R3k3/8/8/8/1Q6/8/8/R3K3 w - - 1 2"),
      [rook],
    )).toEqual([rook]);
  });

  it("Rook Buddies recognizes a connection created on the opponent turn", () => {
    const staleLocked: RookBuddiesState = {
      movesApplied: 2,
      connectedEver: false,
    };
    const rook = move("a1", "a2", "rook");
    expect(rookBuddiesRule.filterLegalMoves(
      context(staleLocked, "R3k3/8/8/8/8/8/8/R3K3 w - - 0 1"),
      [rook],
    )).toEqual([rook]);
  });

  it("Rook Buddies persists an opponent-created connection after disconnecting", () => {
    const staleLocked: RookBuddiesState = {
      movesApplied: 2,
      connectedEver: false,
    };
    const disconnect = move("a1", "b1", "rook");
    const after = rookBuddiesRule.applyMove(
      {
        ...context(staleLocked, "R3k3/8/8/8/8/8/8/R3K3 w - - 0 1"),
        positionAfterMove: {
          fen: "R3k3/8/8/8/8/8/8/1R2K3 b - - 1 1",
          turn: "black",
          ply: 1,
          history: [disconnect],
        },
      },
      disconnect,
    );
    expect(after.connectedEver).toBe(true);
  });

  it("mirrors attack and loss rules for Black", () => {
    const blackRook = move("a7", "b7", "rook", { color: "black" });
    expect(deerInTheHeadlightsRule.filterLegalMoves(
      context(STATE, "4k3/r7/8/8/8/8/8/R3K3 b - - 0 1", "black"),
      [blackRook],
    )).toEqual([]);
    expect(paranoidRule.checkStartOfTurnLoss(context(
      STATE,
      "4k3/8/8/8/8/8/8/4K3 b - - 0 1",
      "black",
    ))).toMatchObject({ color: "black" });
  });

  it("Stand Your Ground treats en-passant as a capture", () => {
    const enPassant = move("e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    expect(standYourGroundRule.filterLegalMoves(
      context(STATE, "4k3/8/8/3pP3/8/8/8/R3K3 w - d6 0 1"),
      [enPassant],
    )).toEqual([]);
  });
});
