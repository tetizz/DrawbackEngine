import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  DrawbackRule,
  PieceType,
  RuleMoveContext,
} from "../types.js";
import type { NoParameters, StatelessRuleState } from "./common.js";
import {
  centralizedCommandRule,
  coweringInFearRule,
  diplomaticImmunityRule,
  doctorOctopusRule,
  flattererRule,
  hauntedRule,
  hedonicTreadmillRule,
  hipsterRule,
  historyFilterRules,
  ladiesFirstRule,
  monkeySeeRule,
  royalJubileeRule,
  scorchedEarthRule,
  turnTheOtherCheekRule,
  velociraptorRule,
  windupToysRule,
} from "./history-filter-rules.js";

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
    readonly san?: string;
  } = {},
): ChessMove {
  return {
    color,
    from,
    to,
    piece,
    san: options.san ?? `${from}-${to}`,
    flags: options.flags ??
      (options.captured === undefined ? "quiet" : "capture"),
    ...(options.captured === undefined ? {} : { captured: options.captured }),
    ...(options.promotion === undefined ? {} : { promotion: options.promotion }),
  };
}

function context(
  color: ChessMove["color"] = "white",
  history: readonly ChessMove[] = [],
  fen = BASE_FEN,
): RuleMoveContext<StatelessRuleState, NoParameters> {
  return {
    color,
    parameters: {},
    state: { movesApplied: history.filter((entry) => entry.color === color).length },
    position: {
      fen,
      turn: color,
      ply: history.length,
      history,
    },
  };
}

function allowed(
  rule: DrawbackRule<StatelessRuleState, NoParameters>,
  candidates: readonly ChessMove[],
  history: readonly ChessMove[] = [],
  color: ChessMove["color"] = "white",
  fen = BASE_FEN,
): readonly ChessMove[] {
  return rule.filterLegalMoves(context(color, history, fen), candidates);
}

const whiteQuiet = move("white", "a2", "a3", "pawn");
const whiteKnight = move("white", "b1", "c3", "knight");
const whiteBishop = move("white", "c1", "g5", "bishop");
const whiteRook = move("white", "a1", "a4", "rook");
const whiteQueen = move("white", "d1", "d3", "queen");
const whiteKing = move("white", "e1", "e2", "king");
const whiteCastle = move("white", "e1", "g1", "king", {
  flags: "quiet,kingside-castle",
  san: "O-O",
});
const whiteCapture = move("white", "c3", "d5", "knight", {
  captured: "pawn",
});

describe("history filter rule metadata", () => {
  it("publishes fifteen unique implemented rules", () => {
    expect(historyFilterRules).toHaveLength(15);
    expect(new Set(historyFilterRules.map(({ id }) => id)).size).toBe(15);
    expect(historyFilterRules.every(
      ({ verification }) => verification === "implemented-unverified",
    )).toBe(true);
  });

  it("increments state without mutating the preceding state", () => {
    const before = { movesApplied: 4 };
    const after = hauntedRule.applyMove(
      {
        ...context("white"),
        state: before,
        positionAfterMove: context("black").position,
      },
      whiteQuiet,
    );
    expect(after).toEqual({ movesApplied: 5 });
    expect(before).toEqual({ movesApplied: 4 });
  });

  it("returns fresh move arrays and never mutates the ordinary move list", () => {
    const candidates = [whiteQuiet, whiteKnight];
    const snapshot = [...candidates];
    const filtered = hipsterRule.filterLegalMoves(context(), candidates);
    expect(filtered).not.toBe(candidates);
    expect(candidates).toEqual(snapshot);
  });
});

describe("Diplomatic Immunity", () => {
  it("protects only the opponent's last quiet mover", () => {
    const last = move("black", "g8", "f6", "knight");
    const capturesLast = move("white", "e4", "f6", "pawn", {
      captured: "knight",
    });
    const capturesOther = move("white", "c4", "f7", "bishop", {
      captured: "pawn",
    });
    expect(allowed(
      diplomaticImmunityRule,
      [whiteQuiet, capturesLast, capturesOther],
      [last],
    )).toEqual([whiteQuiet, capturesOther]);
  });

  it("permits capturing a last mover whose move was a capture", () => {
    const last = move("black", "f6", "e4", "knight", {
      captured: "pawn",
    });
    const recapture = move("white", "d3", "e4", "queen", {
      captured: "knight",
    });
    expect(allowed(diplomaticImmunityRule, [recapture], [last]))
      .toEqual([recapture]);
  });

  it("protects the last mover from en-passant after a quiet double push", () => {
    const doublePush = move("black", "d7", "d5", "pawn");
    const enPassant = move("white", "e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    expect(allowed(diplomaticImmunityRule, [whiteQuiet, enPassant], [doublePush]))
      .toEqual([whiteQuiet]);
  });

  it("protects the secondary rook that just moved during castling", () => {
    const castle = move("black", "e8", "g8", "king", {
      flags: "quiet,kingside-castle",
      san: "O-O",
    });
    const captureRook = move("white", "f1", "f8", "rook", {
      captured: "rook",
    });
    expect(allowed(diplomaticImmunityRule, [whiteQuiet, captureRook], [castle]))
      .toEqual([whiteQuiet]);
  });

  it("is unrestricted without opponent history", () => {
    expect(allowed(diplomaticImmunityRule, [whiteQuiet, whiteCapture]))
      .toEqual([whiteQuiet, whiteCapture]);
  });
});

describe("Flatterer and Hipster", () => {
  it("Flatterer matches the pawn/non-pawn class of the previous opponent mover", () => {
    const pawn = move("black", "e7", "e5", "pawn");
    const knight = move("black", "g8", "f6", "knight");
    expect(allowed(flattererRule, [whiteQuiet, whiteKnight], [pawn]))
      .toEqual([whiteQuiet]);
    expect(allowed(flattererRule, [whiteQuiet, whiteKnight, whiteQueen], [knight]))
      .toEqual([whiteKnight, whiteQueen]);
  });

  it("Flatterer treats a promotion as a pawn move and castling as non-pawn", () => {
    const promotion = move("black", "a2", "a1", "pawn", {
      promotion: "queen",
      flags: "quiet,promotion",
    });
    const castle = move("black", "e8", "c8", "king", {
      flags: "quiet,queenside-castle",
      san: "O-O-O",
    });
    expect(allowed(flattererRule, [whiteQuiet, whiteQueen], [promotion]))
      .toEqual([whiteQuiet]);
    expect(allowed(flattererRule, [whiteQuiet, whiteQueen], [castle]))
      .toEqual([whiteQueen]);
  });

  it("Hipster forbids exactly the previous opponent primary mover type", () => {
    const knight = move("black", "g8", "f6", "knight");
    expect(allowed(
      hipsterRule,
      [whiteQuiet, whiteKnight, whiteBishop],
      [knight],
    )).toEqual([whiteQuiet, whiteBishop]);
  });

  it("Hipster treats promotion as pawn and castling as king", () => {
    const promotion = move("black", "a2", "a1", "pawn", {
      promotion: "rook",
      flags: "quiet,promotion",
    });
    const castle = move("black", "e8", "g8", "king", {
      flags: "quiet,kingside-castle",
      san: "O-O",
    });
    expect(allowed(hipsterRule, [whiteQuiet, whiteRook], [promotion]))
      .toEqual([whiteRook]);
    expect(allowed(hipsterRule, [whiteKing, whiteCastle, whiteRook], [castle]))
      .toEqual([whiteRook]);
  });

  it("both rules are unrestricted without an opponent move", () => {
    expect(allowed(flattererRule, [whiteQuiet, whiteKnight]))
      .toEqual([whiteQuiet, whiteKnight]);
    expect(allowed(hipsterRule, [whiteQuiet, whiteKnight]))
      .toEqual([whiteQuiet, whiteKnight]);
  });
});

describe("Hedonic Treadmill and Cowering in Fear", () => {
  it("Hedonic Treadmill uses the last opponent mover's value", () => {
    const rookMove = move("black", "a8", "a6", "rook");
    expect(allowed(
      hedonicTreadmillRule,
      [whiteQuiet, whiteKnight, whiteRook, whiteQueen, whiteKing],
      [rookMove],
    )).toEqual([whiteRook, whiteQueen, whiteKing]);
  });

  it("Hedonic Treadmill counts bishop and knight equally and king as infinite", () => {
    const bishopMove = move("black", "c8", "g4", "bishop");
    const kingMove = move("black", "e8", "e7", "king");
    expect(allowed(
      hedonicTreadmillRule,
      [whiteQuiet, whiteKnight, whiteBishop],
      [bishopMove],
    )).toEqual([whiteKnight, whiteBishop]);
    expect(allowed(
      hedonicTreadmillRule,
      [whiteQueen, whiteKing],
      [kingMove],
    )).toEqual([whiteKing]);
  });

  it("Hedonic Treadmill values a promotion by its resulting piece", () => {
    const promotedRook = move("black", "a2", "a1", "pawn", {
      promotion: "rook",
      flags: "quiet,promotion",
    });
    const whitePromotion = move("white", "h7", "h8", "pawn", {
      promotion: "queen",
      flags: "quiet,promotion",
    });
    expect(allowed(
      hedonicTreadmillRule,
      [whiteQuiet, whiteKnight, whiteRook, whitePromotion],
      [promotedRook],
    )).toEqual([whiteRook, whitePromotion]);
  });

  it("Cowering in Fear uses the most valuable piece captured by the opponent", () => {
    const pawnCapture = move("black", "d4", "e3", "pawn", {
      captured: "pawn",
    });
    const bishopTakesRook = move("black", "g7", "a1", "bishop", {
      captured: "rook",
    });
    expect(allowed(
      coweringInFearRule,
      [whiteQuiet, whiteKnight, whiteRook, whiteQueen, whiteKing],
      [pawnCapture, bishopTakesRook],
    )).toEqual([whiteRook, whiteQueen, whiteKing]);
  });

  it("Cowering in Fear ignores own captures and is unrestricted before a loss", () => {
    const ownQueenLoss = move("white", "a1", "a8", "rook", {
      captured: "queen",
    });
    expect(allowed(coweringInFearRule, [whiteQuiet, whiteKnight], [ownQueenLoss]))
      .toEqual([whiteQuiet, whiteKnight]);
    expect(allowed(coweringInFearRule, [whiteQuiet, whiteKnight]))
      .toEqual([whiteQuiet, whiteKnight]);
  });
});

describe("Ladies First and Centralized Command", () => {
  it("Ladies First requires the immediately preceding own mover to be a queen", () => {
    const ownQueen = move("white", "d1", "d3", "queen");
    const opponent = move("black", "g8", "f6", "knight");
    expect(allowed(
      ladiesFirstRule,
      [whiteQuiet, whiteKing, whiteCastle],
      [ownQueen, opponent],
    )).toEqual([whiteQuiet, whiteKing, whiteCastle]);

    const laterOwnPawn = move("white", "a2", "a3", "pawn");
    expect(allowed(
      ladiesFirstRule,
      [whiteQuiet, whiteKing],
      [ownQueen, opponent, laterOwnPawn],
    )).toEqual([whiteQuiet]);
  });

  it("Ladies First does not treat promotion to queen as moving a queen", () => {
    const promotion = move("white", "a7", "a8", "pawn", {
      promotion: "queen",
      flags: "quiet,promotion",
    });
    expect(allowed(ladiesFirstRule, [whiteQueen, whiteKing], [promotion]))
      .toEqual([whiteQueen]);
  });

  it("Centralized Command enables captures for exactly three own turns", () => {
    const king = move("white", "e1", "e2", "king");
    const blackA = move("black", "a7", "a6", "pawn");
    const blackB = move("black", "b7", "b6", "pawn");
    const blackC = move("black", "c7", "c6", "pawn");
    const blackD = move("black", "d7", "d6", "pawn");
    const ownA = move("white", "a2", "a3", "pawn");
    const ownB = move("white", "b2", "b3", "pawn");
    const ownC = move("white", "c2", "c3", "pawn");
    expect(allowed(
      centralizedCommandRule,
      [whiteQuiet, whiteCapture],
      [king, blackA, ownA, blackB, ownB, blackC],
    )).toEqual([whiteQuiet, whiteCapture]);
    expect(allowed(
      centralizedCommandRule,
      [whiteQuiet, whiteCapture],
      [
        king,
        blackA,
        ownA,
        blackB,
        ownB,
        blackC,
        ownC,
        blackD,
      ],
    )).toEqual([whiteQuiet]);
  });

  it("Centralized Command counts castling and blocks every capture form otherwise", () => {
    const opponent = move("black", "a7", "a6", "pawn");
    const enPassant = move("white", "e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const capturePromotion = move("white", "a7", "b8", "pawn", {
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(allowed(
      centralizedCommandRule,
      [whiteQuiet, enPassant, capturePromotion],
      [whiteCastle, opponent],
    )).toEqual([whiteQuiet, enPassant, capturePromotion]);
    expect(allowed(
      centralizedCommandRule,
      [whiteQuiet, enPassant, capturePromotion],
      [opponent],
    )).toEqual([whiteQuiet]);
  });
});

describe("Royal Jubilee and Monkey See", () => {
  it("Royal Jubilee forces king or queen after an own non-pawn capture", () => {
    const ownCapture = move("white", "c3", "d5", "knight", {
      captured: "bishop",
    });
    const opponent = move("black", "a7", "a6", "pawn");
    expect(allowed(
      royalJubileeRule,
      [whiteQuiet, whiteKnight, whiteQueen, whiteKing, whiteCastle],
      [ownCapture, opponent],
    )).toEqual([whiteQueen, whiteKing, whiteCastle]);
  });

  it("Royal Jubilee does not trigger for pawn captures or en-passant", () => {
    const pawnCapture = move("white", "c4", "d5", "pawn", {
      captured: "pawn",
    });
    const enPassant = move("white", "e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    expect(allowed(royalJubileeRule, [whiteQuiet, whiteKnight], [pawnCapture]))
      .toEqual([whiteQuiet, whiteKnight]);
    expect(allowed(royalJubileeRule, [whiteQuiet, whiteKnight], [enPassant]))
      .toEqual([whiteQuiet, whiteKnight]);
  });

  it("Royal Jubilee uses the captured type on a capture-promotion", () => {
    const capturePromotion = move("white", "a7", "b8", "pawn", {
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    const quietPromotion = move("white", "a7", "a8", "pawn", {
      promotion: "queen",
      flags: "quiet,promotion",
    });
    expect(allowed(
      royalJubileeRule,
      [whiteQuiet, whiteQueen],
      [capturePromotion],
    )).toEqual([whiteQueen]);
    expect(allowed(
      royalJubileeRule,
      [whiteQuiet, whiteQueen],
      [quietPromotion],
    )).toEqual([whiteQuiet, whiteQueen]);
  });

  it("Monkey See accumulates opponent capturing mover types only", () => {
    const opponentRook = move("black", "a8", "a2", "rook", {
      captured: "pawn",
    });
    const ownBishop = move("white", "c1", "h6", "bishop", {
      captured: "pawn",
    });
    const rookCapture = move("white", "a1", "a7", "rook", {
      captured: "pawn",
    });
    const bishopCapture = move("white", "c1", "g5", "bishop", {
      captured: "knight",
    });
    expect(allowed(
      monkeySeeRule,
      [whiteQuiet, rookCapture, bishopCapture],
      [opponentRook, ownBishop],
    )).toEqual([whiteQuiet, rookCapture]);
  });

  it("Monkey See treats en-passant and capture-promotion as pawn captures", () => {
    const opponentEnPassant = move("black", "d4", "e3", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const capturePromotion = move("white", "a7", "b8", "pawn", {
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(allowed(
      monkeySeeRule,
      [whiteQuiet, capturePromotion],
      [opponentEnPassant],
    )).toEqual([whiteQuiet, capturePromotion]);
  });

  it("Monkey See rejects every capture before the opponent demonstrates one", () => {
    expect(allowed(monkeySeeRule, [whiteQuiet, whiteCapture]))
      .toEqual([whiteQuiet]);
  });
});

describe("Haunted and Scorched Earth", () => {
  it("Haunted permanently blocks own capture destinations only", () => {
    const ownCapture = move("white", "c3", "d5", "knight", {
      captured: "pawn",
    });
    const opponentCapture = move("black", "c6", "b4", "knight", {
      captured: "pawn",
    });
    const toOwn = move("white", "d1", "d5", "queen");
    const toOpponent = move("white", "b1", "b4", "rook");
    expect(allowed(
      hauntedRule,
      [whiteQuiet, toOwn, toOpponent],
      [ownCapture, opponentCapture],
    )).toEqual([whiteQuiet, toOpponent]);
  });

  it("Haunted records en-passant and capture-promotion landing squares", () => {
    const enPassant = move("white", "e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    const promotion = move("white", "a7", "b8", "pawn", {
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    const toD6 = move("white", "d1", "d6", "queen");
    const toB8 = move("white", "b1", "b8", "rook");
    expect(allowed(hauntedRule, [whiteQuiet, toD6, toB8], [enPassant, promotion]))
      .toEqual([whiteQuiet]);
  });

  it("Scorched Earth blocks every own primary origin permanently", () => {
    const own = move("white", "b1", "c3", "knight");
    const opponent = move("black", "g8", "f6", "knight");
    const toOwnOrigin = move("white", "b4", "b1", "rook");
    const toOpponentOrigin = move("white", "g2", "g8", "rook");
    expect(allowed(
      scorchedEarthRule,
      [whiteQuiet, toOwnOrigin, toOpponentOrigin],
      [own, opponent],
    )).toEqual([whiteQuiet, toOpponentOrigin]);
  });

  it("Scorched Earth burns the secondary rook origin during castling", () => {
    const toRookOrigin = move("white", "h3", "h1", "rook");
    expect(allowed(
      scorchedEarthRule,
      [whiteQuiet, toRookOrigin],
      [whiteCastle],
    )).toEqual([whiteQuiet]);
  });

  it("Scorched Earth rejects unrecognized castling geometry explicitly", () => {
    const malformedCastle = move("white", "d1", "f1", "king", {
      flags: "quiet,kingside-castle",
      san: "O-O",
    });
    expect(() => allowed(
      scorchedEarthRule,
      [whiteQuiet],
      [malformedCastle],
    )).toThrow(RangeError);
  });
});

describe("Turn the Other Cheek and Velociraptor", () => {
  it("Turn the Other Cheek forbids only an immediate recapture", () => {
    const opponentCapture = move("black", "f6", "e4", "knight", {
      captured: "pawn",
    });
    const recapture = move("white", "d3", "e4", "queen", {
      captured: "knight",
    });
    const otherCapture = move("white", "c4", "f7", "bishop", {
      captured: "pawn",
    });
    expect(allowed(
      turnTheOtherCheekRule,
      [whiteQuiet, recapture, otherCapture],
      [opponentCapture],
    )).toEqual([whiteQuiet, otherCapture]);
  });

  it("Turn the Other Cheek permits capture after a quiet move or without history", () => {
    const quiet = move("black", "f6", "e4", "knight");
    expect(allowed(turnTheOtherCheekRule, [whiteCapture], [quiet]))
      .toEqual([whiteCapture]);
    expect(allowed(turnTheOtherCheekRule, [whiteCapture]))
      .toEqual([whiteCapture]);
  });

  it("Velociraptor uses the opponent's last three turns rather than plies", () => {
    const oldRook = move("black", "a8", "a7", "rook");
    const blackPawn = move("black", "a7", "a6", "pawn");
    const blackKnight = move("black", "b8", "c6", "knight");
    const blackBishop = move("black", "c8", "g4", "bishop");
    const interleaved = [
      oldRook,
      whiteQuiet,
      blackPawn,
      whiteKnight,
      blackKnight,
      whiteBishop,
      blackBishop,
    ];
    const takesRook = move("white", "a1", "a7", "rook", {
      captured: "rook",
    });
    const takesKnight = move("white", "c3", "b5", "knight", {
      captured: "knight",
    });
    expect(allowed(
      velociraptorRule,
      [whiteQuiet, takesRook, takesKnight],
      interleaved,
    )).toEqual([whiteQuiet, takesKnight]);
  });

  it("Velociraptor allows en-passant after a pawn move", () => {
    const doublePush = move("black", "d7", "d5", "pawn");
    const enPassant = move("white", "e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    expect(allowed(velociraptorRule, [whiteQuiet, enPassant], [doublePush]))
      .toEqual([whiteQuiet, enPassant]);
  });

  it("Velociraptor treats a promotion as a pawn primary move", () => {
    const promotion = move("black", "a2", "a1", "pawn", {
      promotion: "queen",
      flags: "quiet,promotion",
    });
    const takesPawn = move("white", "b2", "a3", "pawn", {
      captured: "pawn",
    });
    const takesQueen = move("white", "h5", "a5", "queen", {
      captured: "queen",
    });
    expect(allowed(
      velociraptorRule,
      [whiteQuiet, takesPawn, takesQueen],
      [promotion],
    )).toEqual([whiteQuiet, takesPawn]);
  });

  it("Velociraptor rejects captures without opponent mover evidence", () => {
    expect(allowed(velociraptorRule, [whiteQuiet, whiteCapture]))
      .toEqual([whiteQuiet]);
  });
});

describe("Windup Toys", () => {
  const candidates = [whiteKnight, whiteBishop, whiteRook, whiteQueen];

  it("allows every piece through standard fullmove twelve", () => {
    const whiteMove12 = "4k3/8/8/8/8/8/8/4K3 w - - 0 12";
    const blackMove12 = "4k3/8/8/8/8/8/8/4K3 b - - 0 12";
    expect(allowed(windupToysRule, candidates, [], "white", whiteMove12))
      .toEqual(candidates);
    expect(allowed(windupToysRule, candidates, [], "black", blackMove12))
      .toEqual(candidates);
  });

  it("freezes knights and bishops from fullmove thirteen onward", () => {
    const move13 = "4k3/8/8/8/8/8/8/4K3 w - - 0 13";
    expect(allowed(windupToysRule, candidates, [], "white", move13))
      .toEqual([whiteRook, whiteQueen]);
  });

  it("rejects malformed or non-positive FEN fullmove counters", () => {
    expect(() => allowed(
      windupToysRule,
      candidates,
      [],
      "white",
      "4k3/8/8/8/8/8/8/4K3 w - - 0 nope",
    )).toThrow(RangeError);
    expect(() => allowed(
      windupToysRule,
      candidates,
      [],
      "white",
      "4k3/8/8/8/8/8/8/4K3 w - - 0 0",
    )).toThrow(RangeError);
  });
});

describe("Doctor Octopus", () => {
  function historicalCapture(index: number): ChessMove {
    return move("white", `a${String((index % 7) + 1)}`, `b${String((index % 7) + 1)}`, "rook", {
      captured: "pawn",
    });
  }

  it("allows the eighth non-king capture and rejects the ninth", () => {
    const capture = move("white", "a1", "a8", "rook", {
      captured: "queen",
    });
    const seven = Array.from({ length: 7 }, (_, index) => historicalCapture(index));
    const eight = [...seven, historicalCapture(7)];
    expect(allowed(doctorOctopusRule, [whiteQuiet, capture], seven))
      .toEqual([whiteQuiet, capture]);
    expect(allowed(doctorOctopusRule, [whiteQuiet, capture], eight))
      .toEqual([whiteQuiet]);
  });

  it("does not count opponent captures or captures of a king", () => {
    const opponentCaptures = Array.from(
      { length: 8 },
      () => ({
        ...historicalCapture(0),
        color: "black" as const,
      }),
    );
    const kingCaptures = Array.from(
      { length: 8 },
      () => move("white", "a1", "a2", "rook", { captured: "king" }),
    );
    const capture = move("white", "a1", "a8", "rook", {
      captured: "queen",
    });
    expect(allowed(doctorOctopusRule, [capture], opponentCaptures))
      .toEqual([capture]);
    expect(allowed(doctorOctopusRule, [capture], kingCaptures))
      .toEqual([capture]);
  });

  it("still permits quiet moves and king captures after the quota", () => {
    const eight = Array.from({ length: 8 }, (_, index) => historicalCapture(index));
    const kingCapture = move("white", "a1", "a8", "rook", {
      captured: "king",
    });
    const enPassant = move("white", "e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    expect(allowed(
      doctorOctopusRule,
      [whiteQuiet, kingCapture, enPassant],
      eight,
    )).toEqual([whiteQuiet, kingCapture]);
  });
});

describe("color isolation", () => {
  it("applies the same history semantics from Black's perspective", () => {
    const whiteRookCapture = move("white", "a1", "a7", "rook", {
      captured: "pawn",
    });
    const blackRookCapture = move("black", "a8", "a2", "rook", {
      captured: "pawn",
    });
    const blackRook = move("black", "a8", "a1", "rook", {
      captured: "queen",
    });
    const blackBishop = move("black", "c8", "h3", "bishop", {
      captured: "pawn",
    });
    expect(allowed(
      monkeySeeRule,
      [blackRook, blackBishop],
      [whiteRookCapture, blackRookCapture],
      "black",
    )).toEqual([blackRook]);
  });
});
