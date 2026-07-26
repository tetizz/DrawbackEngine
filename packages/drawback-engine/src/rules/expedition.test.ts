import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  PieceType,
  PositionView,
  PromotionPiece,
  RuleMoveContext,
} from "../types.js";
import type {
  NoParameters,
  StatelessRuleState,
} from "./common.js";
import { expeditionRule } from "./expedition.js";

function move(
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly color?: ChessMove["color"];
    readonly captured?: PieceType;
    readonly promotion?: PromotionPiece;
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
    ...(options.promotion === undefined ? {} : {
      promotion: options.promotion,
    }),
  };
}

function historyMove(color: ChessMove["color"], index: number): ChessMove {
  return move("a2", "a3", "pawn", {
    color,
    flags: `fixture-${String(index)}`,
  });
}

function position(
  history: readonly ChessMove[],
  turn: ChessMove["color"] = "white",
): PositionView {
  return {
    fen: `8/8/8/8/8/8/8/8 ${turn === "white" ? "w" : "b"} - - 0 1`,
    turn,
    ply: history.length,
    history,
  };
}

function context(
  movesApplied: number,
  color: ChessMove["color"] = "white",
): RuleMoveContext<StatelessRuleState, NoParameters> {
  return {
    color,
    parameters: {},
    state: { movesApplied },
    position: position([], color),
  };
}

describe("Expedition", () => {
  const reachesF1 = move("e2", "f1", "bishop");
  const missesF1 = move("e2", "e3", "bishop");

  it("is unrestricted before and after the affected player's fifteenth turn", () => {
    const moves = [reachesF1, missesF1];
    expect(expeditionRule.filterLegalMoves(context(13), moves)).toEqual(moves);
    expect(expeditionRule.filterLegalMoves(context(15), moves)).toEqual(moves);
  });

  it("forces primary destination f1 on the fifteenth turn", () => {
    expect(
      expeditionRule.filterLegalMoves(
        context(14),
        [missesF1, reachesF1],
      ),
    ).toEqual([reachesF1]);
  });

  it("reconstructs affected-player history independently for both colors", () => {
    const history = [
      ...Array.from({ length: 14 }, (_, index) =>
        historyMove("white", index)
      ),
      ...Array.from({ length: 9 }, (_, index) =>
        historyMove("black", index)
      ),
    ];
    expect(expeditionRule.initialize({
      color: "white",
      parameters: {},
      position: position(history),
    })).toEqual({ movesApplied: 14 });
    expect(expeditionRule.initialize({
      color: "black",
      parameters: {},
      position: position(history, "black"),
    })).toEqual({ movesApplied: 9 });
    expect(
      expeditionRule.filterLegalMoves(
        context(14, "black"),
        [
          move("g2", "f1", "bishop", { color: "black" }),
          move("g2", "h1", "bishop", { color: "black" }),
        ],
      ).map(({ to }) => to),
    ).toEqual(["f1"]);
  });

  it("classifies special moves only by their primary destination", () => {
    const capture = move("g2", "f1", "bishop", {
      captured: "rook",
    });
    const promotion = move("f2", "f1", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    const enPassant = move("e5", "f6", "pawn", {
      captured: "pawn",
      flags: "en-passant",
    });
    expect(
      expeditionRule.filterLegalMoves(
        context(14),
        [capture, promotion, castle, enPassant],
      ),
    ).toEqual([capture, promotion]);
  });

  it("returns an empty mask when no ordinary move reaches f1", () => {
    expect(
      expeditionRule.filterLegalMoves(
        context(14),
        [missesF1, move("e1", "g1", "king")],
      ),
    ).toEqual([]);
    expect(expeditionRule.checkStartOfTurnLoss(context(14))).toBeNull();
  });

  it("advances state immutably and discloses the deadline only while active", () => {
    const before = { movesApplied: 14 };
    const selected = move("e2", "f1", "bishop");
    const after = expeditionRule.applyMove(
      {
        ...context(before.movesApplied),
        state: before,
        positionAfterMove: position([selected], "black"),
      },
      selected,
    );
    expect(after).toEqual({ movesApplied: 15 });
    expect(before).toEqual({ movesApplied: 14 });
    expect(expeditionRule.describeTurn?.(context(13))).toEqual([]);
    expect(expeditionRule.describeTurn?.(context(14))).toEqual([
      "Expedition: this move must end on f1.",
    ]);
    expect(expeditionRule.describeTurn?.(context(15))).toEqual([]);
  });
});
