import type { PlayerColor } from "@drawbackengine/shared";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  RuleMoveContext,
} from "../types.js";
import type {
  NoParameters,
  StatelessRuleState,
} from "./common.js";
import {
  bridgeOverTroubledWaterRule,
  bridgePermitsMove,
} from "./bridge-over-troubled-water.js";

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

function context(
  color: PlayerColor = "white",
  history: readonly ChessMove[] = [],
): RuleMoveContext<StatelessRuleState, NoParameters> {
  return {
    color,
    parameters: {},
    state: {
      movesApplied: history.filter((candidate) => candidate.color === color).length,
    },
    position: {
      fen: `8/8/8/8/8/8/8/8 ${color === "white" ? "w" : "b"} - - 0 1`,
      turn: color,
      ply: history.length,
      history,
    },
  };
}

describe("Bridge Over Troubled Water", () => {
  it("publishes reviewed executable metadata", () => {
    expect(bridgeOverTroubledWaterRule).toMatchObject({
      id: "bridge-over-troubled-water",
      name: "Bridge Over Troubled Water",
      verification: "implemented-unverified",
    });
  });

  it("forbids water landings on both river ranks and permits bridge landings", () => {
    const water = [
      move("a3", "a4", "pawn"),
      move("b3", "b4", "pawn"),
      move("c3", "c4", "pawn"),
      move("f6", "f5", "pawn", { color: "black" }),
      move("g6", "g5", "pawn", { color: "black" }),
      move("h6", "h5", "pawn", { color: "black" }),
    ];
    const bridge = [
      move("d3", "d4", "pawn"),
      move("e3", "e4", "pawn"),
      move("d6", "d5", "pawn", { color: "black" }),
      move("e6", "e5", "pawn", { color: "black" }),
    ];

    expect(water.every((candidate) => !bridgePermitsMove(candidate))).toBe(true);
    expect(bridge.every((candidate) => bridgePermitsMove(candidate))).toBe(true);
  });

  it("allows vertical crossings through d/e and rejects off-center crossings", () => {
    expect(bridgePermitsMove(move("d3", "d6", "rook"))).toBe(true);
    expect(bridgePermitsMove(move("e6", "e3", "rook", { color: "black" })))
      .toBe(true);
    expect(bridgePermitsMove(move("c3", "c6", "rook"))).toBe(false);
    expect(bridgePermitsMove(move("f6", "f3", "rook", { color: "black" })))
      .toBe(false);
  });

  it("allows diagonal crossings only when every river intersection uses the bridge", () => {
    expect(bridgePermitsMove(move("c3", "f6", "bishop"))).toBe(true);
    expect(bridgePermitsMove(move("f6", "c3", "bishop", { color: "black" })))
      .toBe(true);
    expect(bridgePermitsMove(move("b3", "e6", "bishop"))).toBe(false);
    expect(bridgePermitsMove(move("g6", "d3", "bishop", { color: "black" })))
      .toBe(false);
  });

  it("does not impose crossing rules on moves that remain on one bank", () => {
    expect(bridgePermitsMove(move("a1", "h1", "rook"))).toBe(true);
    expect(bridgePermitsMove(move("a8", "h8", "rook", { color: "black" })))
      .toBe(true);
    expect(bridgePermitsMove(move("b2", "c3", "bishop"))).toBe(true);
  });

  it("uses primary landing geometry for captures and en passant", () => {
    const waterCapture = move("b3", "c4", "bishop", {
      captured: "knight",
    });
    const bridgeCapture = move("c3", "d4", "bishop", {
      captured: "knight",
    });
    const whiteEnPassant = move("d5", "e6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });
    const blackEnPassant = move("e4", "d3", "pawn", {
      color: "black",
      captured: "pawn",
      flags: "en-passant",
    });

    expect(bridgePermitsMove(waterCapture)).toBe(false);
    expect(bridgePermitsMove(bridgeCapture)).toBe(true);
    expect(bridgePermitsMove(whiteEnPassant)).toBe(true);
    expect(bridgePermitsMove(blackEnPassant)).toBe(true);
  });

  it("leaves castling and promotion outside the river unrestricted", () => {
    const castles = [
      move("e1", "g1", "king", { flags: "kingside-castle" }),
      move("e1", "c1", "king", { flags: "queenside-castle" }),
      move("e8", "g8", "king", {
        color: "black",
        flags: "kingside-castle",
      }),
      move("e8", "c8", "king", {
        color: "black",
        flags: "queenside-castle",
      }),
    ];
    const promotions = [
      move("a7", "a8", "pawn", {
        promotion: "queen",
        flags: "promotion",
      }),
      move("h2", "h1", "pawn", {
        color: "black",
        promotion: "knight",
        flags: "promotion",
      }),
    ];

    expect([...castles, ...promotions].every(bridgePermitsMove)).toBe(true);
  });

  it("permits knights on bridge squares but not water squares", () => {
    expect(bridgePermitsMove(move("b3", "d4", "knight"))).toBe(true);
    expect(bridgePermitsMove(move("d3", "c5", "knight"))).toBe(false);
    expect(bridgePermitsMove(move("f6", "e4", "knight", { color: "black" })))
      .toBe(true);
    expect(bridgePermitsMove(move("e6", "g5", "knight", { color: "black" })))
      .toBe(false);
  });

  it("returns a fresh subset without mutating the ordinary move list", () => {
    const allowed = move("d3", "d6", "rook");
    const forbidden = move("c3", "c6", "rook");
    const ordinary = Object.freeze([allowed, forbidden]);

    const first = bridgeOverTroubledWaterRule.filterLegalMoves(
      context(),
      ordinary,
    );
    const second = bridgeOverTroubledWaterRule.filterLegalMoves(
      context(),
      ordinary,
    );

    expect(first).toEqual([allowed]);
    expect(second).toEqual(first);
    expect(first).not.toBe(ordinary);
    expect(ordinary).toEqual([allowed, forbidden]);
  });

  it("returns an empty mask when every ordinary move lands in water", () => {
    expect(bridgeOverTroubledWaterRule.filterLegalMoves(context(), [
      move("a3", "a4", "pawn"),
      move("b3", "c4", "bishop"),
      move("e3", "f5", "knight"),
    ])).toEqual([]);
  });

  it("counts only affected-player history and advances state once per move", () => {
    const history = [
      move("e2", "e3", "pawn"),
      move("e7", "e6", "pawn", { color: "black" }),
      move("g1", "f3", "knight"),
    ];
    const initialized = bridgeOverTroubledWaterRule.initialize({
      color: "white",
      parameters: {},
      position: context("white", history).position,
    });
    expect(initialized).toEqual({ movesApplied: 2 });
    expect(bridgeOverTroubledWaterRule.applyMove(
      {
        ...context("white", history),
        state: initialized,
        positionAfterMove: {
          ...context("black", history).position,
          ply: history.length + 1,
        },
      },
      move("d3", "d4", "pawn"),
    )).toEqual({ movesApplied: 3 });
  });
});
