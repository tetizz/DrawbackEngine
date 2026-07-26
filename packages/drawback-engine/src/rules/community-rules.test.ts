import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ChessMove,
  DrawbackRule,
  PieceType,
  RuleMoveContext,
  RuleTransitionContext,
} from "../types.js";
import type { PlayerColor } from "@drawbackengine/shared";
import type { NoParameters } from "./common.js";
import {
  alternatorRule,
  champingAtTheBitRule,
  communityRules,
  controlCenterRule,
  elephantsFearMiceRule,
  farSightedRule,
  greedyRule,
  hopscotchRule,
  indecisiveRule,
  outOfBreathRule,
  professionalCourtesyRule,
  queenBeeRule,
  scentOfBloodRule,
  snipersRule,
  stayAtHomeMomRule,
  whitesOfTheirEyesRule,
} from "./community-rules.js";

function move(
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly color?: PlayerColor;
    readonly captured?: PieceType;
    readonly flags?: string;
  } = {},
): ChessMove {
  return {
    from,
    to,
    piece,
    color: options.color ?? "white",
    ...(options.captured === undefined ? {} : { captured: options.captured }),
    san: `${from}${to}`,
    flags: options.flags ?? (options.captured === undefined ? "quiet" : "capture"),
  };
}

function context<State>(
  state: State,
  color: PlayerColor = "white",
): RuleMoveContext<State, NoParameters> {
  return {
    color,
    parameters: {},
    state,
    position: {
      fen: `8/8/8/8/8/8/8/8 ${color === "white" ? "w" : "b"} - - 0 1`,
      turn: color,
      ply: 0,
      history: [],
    },
  };
}

function transition<State>(
  state: State,
  color: PlayerColor = "white",
): RuleTransitionContext<State, NoParameters> {
  const before = context(state, color);
  return {
    ...before,
    positionAfterMove: {
      ...before.position,
      turn: color === "white" ? "black" : "white",
      ply: 1,
    },
  };
}

function allowed<State>(
  rule: DrawbackRule<State, NoParameters>,
  state: State,
  moves: readonly ChessMove[],
): readonly string[] {
  return rule
    .filterLegalMoves(context(state), Object.freeze([...moves]))
    .map(({ from, to }) => from + to);
}

const stateless = { movesApplied: 0 };

describe("community rule metadata", () => {
  it("registers fifteen executable but unverified rules", () => {
    expect(communityRules).toHaveLength(15);
    expect(new Set(communityRules.map(({ id }) => id)).size).toBe(15);
    expect(communityRules.every(
      ({ verification }) => verification === "implemented-unverified",
    )).toBe(true);
  });

  it("does not mutate the ordinary move array", () => {
    const moves = Object.freeze([
      move("a1", "a2", "rook"),
      move("a1", "a8", "rook", { captured: "queen" }),
    ]);
    const before = [...moves];
    const filtered = scentOfBloodRule.filterLegalMoves(
      context(stateless),
      moves,
    );
    expect(filtered).not.toBe(moves);
    expect(moves).toEqual(before);
  });

  it("keeps catalog metadata and replay fixtures aligned", () => {
    const catalog = JSON.parse(readFileSync(
      new URL(
        "../../../../data/catalog/community-drawbacks.json",
        import.meta.url,
      ),
      "utf8",
    )) as readonly {
      readonly id: string;
      readonly implementationStatus: string;
      readonly fixture: string;
    }[];
    expect(catalog.map(({ id }) => id)).toEqual(
      communityRules.map(({ id }) => id),
    );
    expect(catalog.every(
      ({ implementationStatus }) =>
        implementationStatus === "implemented-unverified",
    )).toBe(true);
    for (const entry of catalog) {
      const fixtureUrl = new URL(`../../../../${entry.fixture}`, import.meta.url);
      expect(existsSync(fixtureUrl)).toBe(true);
      expect(
        (JSON.parse(readFileSync(fixtureUrl, "utf8")) as { ruleId: string })
          .ruleId,
      ).toBe(entry.id);
    }
  });
});

describe("capture value and type families", () => {
  it("Greedy allows quiet moves and only maximum-value captures", () => {
    const quiet = move("a2", "a3", "pawn");
    const pawn = move("b2", "c3", "pawn", { captured: "pawn" });
    const rook = move("d1", "d8", "queen", { captured: "rook" });
    expect(allowed(greedyRule, stateless, [quiet, pawn, rook]))
      .toEqual(["a2a3", "d1d8"]);
  });

  it("Professional Courtesy blocks equal non-pawn types but not pawn targets", () => {
    const knight = move("b1", "c3", "knight", { captured: "knight" });
    const pawn = move("b1", "a3", "knight", { captured: "pawn" });
    const mixed = move("c1", "h6", "bishop", { captured: "rook" });
    expect(allowed(professionalCourtesyRule, stateless, [knight, pawn, mixed]))
      .toEqual(["b1a3", "c1h6"]);
  });

  it("Elephants Fear Mice permits pawn-on-pawn but blocks non-pawn-on-pawn", () => {
    const rook = move("a1", "a7", "rook", { captured: "pawn" });
    const pawn = move("b6", "a7", "pawn", { captured: "pawn" });
    expect(allowed(elephantsFearMiceRule, stateless, [rook, pawn]))
      .toEqual(["b6a7"]);
  });
});

describe("capture geometry families", () => {
  it("Snipers requires four diagonal squares for bishop captures", () => {
    const short = move("c1", "e3", "bishop", { captured: "knight" });
    const long = move("c1", "g5", "bishop", { captured: "rook" });
    const quiet = move("c1", "d2", "bishop");
    expect(allowed(snipersRule, stateless, [short, long, quiet]))
      .toEqual(["c1g5", "c1d2"]);
  });

  it("Far Sighted blocks orthogonal and diagonal adjacency", () => {
    const adjacent = move("e4", "e5", "rook", { captured: "pawn" });
    const diagonal = move("e4", "f5", "bishop", { captured: "pawn" });
    const remote = move("e4", "e8", "rook", { captured: "queen" });
    expect(allowed(farSightedRule, stateless, [adjacent, diagonal, remote]))
      .toEqual(["e4e8"]);
  });

  it("Whites of Their Eyes uses the documented Manhattan metric", () => {
    const diagonalOne = move("e4", "f5", "bishop", { captured: "pawn" });
    const knight = move("e4", "f6", "knight", { captured: "pawn" });
    const quiet = move("a1", "a8", "rook");
    expect(allowed(whitesOfTheirEyesRule, stateless, [diagonalOne, knight, quiet]))
      .toEqual(["e4f5", "a1a8"]);
  });
});

describe("destination and opportunity families", () => {
  it("Stay at Home Mom uses color-relative home ranks", () => {
    const whiteHome = move("d1", "d2", "queen");
    const whiteAway = move("d1", "d3", "queen");
    const blackHome = move("d8", "d7", "queen", { color: "black" });
    const blackAway = move("d8", "d6", "queen", { color: "black" });
    expect(allowed(stayAtHomeMomRule, stateless, [whiteHome, whiteAway]))
      .toEqual(["d1d2"]);
    expect(stayAtHomeMomRule.filterLegalMoves(
      context(stateless, "black"),
      [blackHome, blackAway],
    )).toEqual([blackHome]);
  });

  it("Champing at the Bit permits distance-two pushes and diagonal captures", () => {
    const single = move("e2", "e3", "pawn");
    const double = move("e2", "e4", "pawn");
    const capture = move("e4", "f5", "pawn", { captured: "knight" });
    const castle = move("e1", "g1", "king", { flags: "kingside-castle" });
    expect(allowed(champingAtTheBitRule, stateless, [single, double, capture, castle]))
      .toEqual(["e2e4", "e4f5", "e1g1"]);
  });

  it("The Scent of Blood forces only the physical piece with a capture", () => {
    const rookQuiet = move("a1", "a2", "rook");
    const rookCapture = move("a1", "a8", "rook", { captured: "queen" });
    const pawnQuiet = move("b2", "b3", "pawn");
    expect(allowed(scentOfBloodRule, stateless, [rookQuiet, rookCapture, pawnQuiet]))
      .toEqual(["a1a8", "b2b3"]);
  });

  it("Indecisive blocks captures only for a piece with multiple capture choices", () => {
    const first = move("d4", "d8", "queen", { captured: "rook" });
    const second = move("d4", "h4", "queen", { captured: "bishop" });
    const quiet = move("d4", "d5", "queen");
    const sole = move("a1", "a8", "rook", { captured: "queen" });
    expect(allowed(indecisiveRule, stateless, [first, second, quiet, sole]))
      .toEqual(["d4d5", "a1a8"]);
  });

  it("Control Center restricts quiet destinations but exempts captures", () => {
    const central = move("a2", "c2", "rook");
    const outside = move("a2", "b2", "rook");
    const capture = move("a2", "a8", "rook", { captured: "queen" });
    expect(allowed(controlCenterRule, stateless, [central, outside, capture]))
      .toEqual(["a2c2", "a2a8"]);
  });
});

describe("stateful community rules", () => {
  it("Out of Breath consumes the king budget on castling", () => {
    const castle = move("e1", "g1", "king", { flags: "kingside-castle" });
    const pawn = move("a2", "a4", "pawn");
    const next = outOfBreathRule.applyMove(
      transition({ kingMoves: 0 }),
      castle,
    );
    expect(next).toEqual({ kingMoves: 1 });
    expect(allowed(outOfBreathRule, next, [castle, pawn])).toEqual(["a2a4"]);
  });

  it("Queen Bee freezes every queen only after a queen capture", () => {
    const queenCapture = move("d1", "d7", "queen", { captured: "pawn" });
    const queenQuiet = move("d1", "d2", "queen");
    const rook = move("a1", "a2", "rook");
    const next = queenBeeRule.applyMove(
      transition({ queenCaptureOccurred: false }),
      queenCapture,
    );
    expect(next.queenCaptureOccurred).toBe(true);
    expect(allowed(queenBeeRule, next, [queenQuiet, rook])).toEqual(["a1a2"]);
  });

  it("Alternator starts unrestricted then alternates pawn class", () => {
    const pawn = move("e2", "e4", "pawn");
    const knight = move("g1", "f3", "knight");
    const afterPawn = alternatorRule.applyMove(
      transition({ previousClass: null }),
      pawn,
    );
    expect(allowed(alternatorRule, afterPawn, [pawn, knight])).toEqual(["g1f3"]);
  });

  it("Hopscotch alternates destination color across every move kind", () => {
    const dark = move("a1", "b2", "bishop");
    const light = move("a1", "a2", "rook");
    const afterDark = hopscotchRule.applyMove(
      transition({ previousClass: null }),
      dark,
    );
    expect(allowed(hopscotchRule, afterDark, [dark, light])).toEqual(["a1a2"]);
  });
});
