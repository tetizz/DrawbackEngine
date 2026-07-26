import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RandomSource } from "@drawbackengine/shared";
import type {
  ChessMove,
  PieceType,
  PositionView,
} from "../types.js";
import {
  capturableKingIrresistibleRule,
  capturableKingRules,
  femmeFataleRule,
  nurturerRule,
  OBSERVED_TRIPLE_PLAY_TYPES,
  resolveCapturableKingRule,
  triplePlayRule,
  youBestNotMissRule,
  type NurturerState,
  type TriplePlayParameters,
  type YouBestNotMissState,
} from "./capturable-king-rules.js";
import { irresistibleRule } from "./geometric-observed-rules.js";
import {
  executableRules,
  preparedExecutableRules,
  resolveExecutableRule,
  resolvePreparedExecutableRule,
} from "./executable-rules.js";

function move(
  from: string,
  to: string,
  piece: PieceType,
  options: {
    readonly color?: ChessMove["color"];
    readonly captured?: PieceType;
    readonly promotion?: ChessMove["promotion"];
    readonly flags?: string;
    readonly san?: string;
  } = {},
): ChessMove {
  return {
    from,
    to,
    piece,
    color: options.color ?? "white",
    san: options.san ?? `${from}-${to}`,
    flags:
      options.flags ??
      (options.captured === undefined ? "quiet" : "capture"),
    ...(options.captured === undefined
      ? {}
      : { captured: options.captured }),
    ...(options.promotion === undefined
      ? {}
      : { promotion: options.promotion }),
  };
}

function position(
  fen: string,
  history: readonly ChessMove[] = [],
): PositionView {
  const turn = fen.split(/\s+/u)[1];
  return {
    fen,
    turn: turn === "b" ? "black" : "white",
    ply: history.length,
    history,
  };
}

function context<State, Parameters>(
  fen: string,
  state: State,
  parameters: Parameters,
  color: ChessMove["color"] = "white",
) {
  return {
    color,
    state,
    parameters,
    position: position(fen),
  };
}

function transition<State, Parameters>(
  rule: {
    applyMove(
      ruleContext: ReturnType<typeof context<State, Parameters>> & {
        readonly positionAfterMove: PositionView;
      },
      selected: ChessMove,
    ): State;
  },
  beforeFen: string,
  afterFen: string,
  state: State,
  parameters: Parameters,
  selected: ChessMove,
  color: ChessMove["color"] = "white",
): State {
  return rule.applyMove(
    {
      ...context(beforeFen, state, parameters, color),
      positionAfterMove: position(afterFen, [selected]),
    },
    selected,
  );
}

class ScriptedRandom implements RandomSource {
  readonly #value: number;

  public constructor(value: number) {
    this.#value = value;
  }

  public next(): number {
    return this.#value;
  }

  public integer(maxExclusive: number): number {
    return Math.floor(this.#value * maxExclusive);
  }
}

const queenKingCapture = move("e7", "e8", "queen", {
  captured: "king",
  san: "Qxe8",
});
const rookKingCapture = move("e7", "e8", "rook", {
  captured: "king",
  san: "Rxe8",
});
const quietMove = move("a1", "a2", "rook");

describe("capturable-king drawback registry", () => {
  it("keeps five unique rules scoped only to capturable-king/v1", () => {
    expect(capturableKingRules.map(({ id }) => id)).toEqual([
      "femme-fatale",
      "nurturer",
      "triple-play",
      "you-best-not-miss",
      "irresistible",
    ]);
    expect(new Set(capturableKingRules.map(({ id }) => id)).size).toBe(5);
    expect(capturableKingRules.every(
      (rule) =>
        rule.verification === "implemented-unverified" &&
        rule.supportedAuthorities?.length === 1 &&
        rule.supportedAuthorities[0] === "capturable-king/v1",
    )).toBe(true);
    for (const rule of capturableKingRules) {
      expect(resolveCapturableKingRule(rule.id)).toBe(rule);
    }
    expect(() => resolveCapturableKingRule("vegan")).toThrow(
      "Unknown capturable-king drawback rule",
    );
  });

  it("separates authority completion from the frozen standard Irresistible rule", () => {
    const capturableOnlyIds = capturableKingRules
      .map(({ id }) => id)
      .filter((id) => id !== "irresistible");
    expect(
      executableRules.some((rule) => capturableOnlyIds.includes(rule.id)),
    ).toBe(false);
    expect(
      preparedExecutableRules.some(
        (rule) => capturableOnlyIds.includes(rule.id),
      ),
    ).toBe(false);
    for (const id of capturableOnlyIds) {
      expect(() => resolveExecutableRule(id)).toThrow(
        "Unknown executable drawback rule",
      );
      expect(() => resolvePreparedExecutableRule(id)).toThrow(
        "Unknown prepared executable drawback rule",
      );
    }
    expect(resolveExecutableRule("irresistible")).toBe(irresistibleRule);
    expect(resolvePreparedExecutableRule("irresistible")).toBe(
      irresistibleRule,
    );
    expect(resolveCapturableKingRule("irresistible")).toBe(
      capturableKingIrresistibleRule,
    );
    expect(capturableKingIrresistibleRule).not.toBe(irresistibleRule);
    expect(irresistibleRule.verification).toBe("partial");
    expect(irresistibleRule.supportedAuthorities).toBeUndefined();
    expect(preparedExecutableRules).toHaveLength(182);
  });

  it("binds the v3 catalog fragment to the authority-scoped registry", () => {
    const catalog = JSON.parse(readFileSync(
      new URL(
        "../../../../data/catalog/capturable-king-drawbacks-v3.json",
        import.meta.url,
      ),
      "utf8",
    )) as {
      readonly schemaVersion: number;
      readonly authorityId: string;
      readonly rules: readonly {
        readonly id: string;
        readonly implementationStatus: string;
        readonly parameterSchema: unknown;
        readonly tests: readonly string[];
        readonly fixture: string;
      }[];
    };
    expect(catalog.schemaVersion).toBe(3);
    expect(catalog.authorityId).toBe("capturable-king/v1");
    expect(catalog.rules.map(({ id }) => id)).toEqual(
      capturableKingRules.map(({ id }) => id),
    );
    expect(catalog.rules.every(
      (entry) =>
        entry.implementationStatus === "implemented-unverified" &&
        entry.parameterSchema !== null &&
        entry.tests.includes(
          "packages/drawback-engine/src/rules/capturable-king-rules.test.ts",
        ) &&
        readFileSync(
          new URL(`../../../../${entry.fixture}`, import.meta.url),
          "utf8",
        ).length > 0,
    )).toBe(true);
  });
});

describe("Irresistible under capturable-king/v1", () => {
  // drawback-evidence:irresistible:positive
  it("forces every newly adjacent move while retaining literal king captures", () => {
    const forced = move("c5", "d7", "knight");
    const kingCapture = move("e7", "e8", "rook", {
      captured: "king",
    });
    const quiet = move("c5", "a4", "knight");
    const moves = Object.freeze([
      Object.freeze(forced),
      Object.freeze(kingCapture),
      Object.freeze(quiet),
    ]);
    const snapshot = structuredClone(moves);

    expect(capturableKingIrresistibleRule.filterLegalMoves(
      context(
        "4k3/4R3/8/2N5/8/8/8/K7 w - - 0 1",
        { movesApplied: 0 },
        {},
      ),
      moves,
    )).toEqual([forced, kingCapture]);
    expect(moves).toEqual(snapshot);
  });

  // drawback-evidence:irresistible:negative
  it("rejects a quiet alternative and applies the same forcing to Black", () => {
    const forced = move("c4", "d2", "knight", { color: "black" });
    const quiet = move("c4", "a3", "knight", { color: "black" });
    expect(capturableKingIrresistibleRule.filterLegalMoves(
      context(
        "8/8/8/8/2n5/8/8/4K2k b - - 0 1",
        { movesApplied: 0 },
        {},
        "black",
      ),
      [quiet, forced],
    )).toEqual([forced]);
  });

  // drawback-evidence:irresistible:promotion
  it("uses the primary promotion destination for new adjacency", () => {
    const promotion = move("d7", "e8", "pawn", {
      captured: "rook",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(capturableKingIrresistibleRule.filterLegalMoves(
      context(
        "4rk2/3P4/8/8/8/8/P7/K7 w - - 0 1",
        { movesApplied: 0 },
        {},
      ),
      [move("a2", "a3", "pawn"), promotion],
    )).toEqual([promotion]);
  });

  // drawback-evidence:irresistible:castling
  it("uses the primary king destination for castling adjacency", () => {
    const castle = move("e1", "g1", "king", {
      flags: "kingside-castle",
    });
    expect(capturableKingIrresistibleRule.filterLegalMoves(
      context(
        "8/8/8/8/8/8/P6k/4K2R w K - 0 1",
        { movesApplied: 0 },
        {},
      ),
      [move("a2", "a3", "pawn"), castle],
    )).toEqual([castle]);
  });

  // drawback-evidence:irresistible:enPassant
  it("uses the capturing pawn destination for en-passant adjacency", () => {
    const enPassant = move("e5", "d6", "pawn", {
      captured: "pawn",
      flags: "capture,en-passant",
    });
    expect(capturableKingIrresistibleRule.filterLegalMoves(
      context(
        "8/2k5/8/3pP3/8/8/8/K7 w - d6 0 1",
        { movesApplied: 0 },
        {},
      ),
      [move("a1", "b1", "king"), enPassant],
    )).toEqual([enPassant]);
  });

  // drawback-evidence:irresistible:edge
  it("leaves no-trigger turns unrestricted, including already-adjacent pieces", () => {
    const moves = [
      move("d7", "f7", "knight"),
      move("a2", "a3", "pawn"),
    ];
    expect(capturableKingIrresistibleRule.filterLegalMoves(
      context(
        "4k3/3N4/8/8/8/8/P7/K7 w - - 0 1",
        { movesApplied: 0 },
        {},
      ),
      moves,
    )).toEqual(moves);
  });
});

describe("Femme Fatale", () => {
  // drawback-evidence:femme-fatale:positive
  it("allows a primary queen to capture the opposing king", () => {
    const ruleContext = context(
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
      { movesApplied: 0 },
      {},
    );
    expect(femmeFataleRule.filterLegalMoves(
      ruleContext,
      [queenKingCapture, quietMove],
    )).toEqual([queenKingCapture, quietMove]);
    expect(
      femmeFataleRule.explainMove?.(ruleContext, queenKingCapture),
    ).toEqual([]);
    expect(
      femmeFataleRule.explainMove?.(ruleContext, rookKingCapture),
    ).toEqual([
      expect.objectContaining({
        ruleId: "femme-fatale",
        kind: "eliminated",
      }),
    ]);
  });

  // drawback-evidence:femme-fatale:negative
  it("rejects every non-queen primary king capture", () => {
    const captures = (
      ["pawn", "knight", "bishop", "rook", "king"] as const
    ).map((piece) =>
      move("e7", "e8", piece, {
        captured: "king",
      })
    );
    expect(femmeFataleRule.filterLegalMoves(
      context(
        "4k3/4R3/8/8/8/8/8/K7 w - - 0 1",
        { movesApplied: 0 },
        {},
      ),
      [...captures, quietMove],
    )).toEqual([quietMove]);
  });

  // drawback-evidence:femme-fatale:promotion
  it("treats a capture-promotion as a pawn move, but a later promoted queen as a queen", () => {
    const promoteWhileCapturingKing = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(femmeFataleRule.filterLegalMoves(
      context(
        "1k6/P7/8/8/8/8/8/K7 w - - 0 1",
        { movesApplied: 0 },
        {},
      ),
      [promoteWhileCapturingKing],
    )).toEqual([]);
    expect(femmeFataleRule.filterLegalMoves(
      context(
        "1k6/1Q6/8/8/8/8/8/K7 w - - 0 1",
        { movesApplied: 1 },
        {},
      ),
      [move("b7", "b8", "queen", { captured: "king" })],
    )).toHaveLength(1);
  });

  // drawback-evidence:femme-fatale:edge
  it("preserves ordinary captures, castling, en-passant, and immutable input", () => {
    const moves = [
      move("d1", "d7", "queen", { captured: "rook" }),
      move("e1", "g1", "king", { flags: "kingside-castle" }),
      move("e5", "d6", "pawn", {
        captured: "pawn",
        flags: "capture,en-passant",
      }),
      rookKingCapture,
    ];
    const snapshot = structuredClone(moves);
    expect(femmeFataleRule.filterLegalMoves(
      context(
        "4k3/3r4/8/3pP3/8/8/8/3QK2R w K d6 0 1",
        { movesApplied: 0 },
        {},
      ),
      moves,
    )).toEqual(moves.slice(0, 3));
    expect(moves).toEqual(snapshot);
  });

  it("applies the same primary-mover rule to Black", () => {
    const blackQueenCapture = {
      ...queenKingCapture,
      color: "black" as const,
    };
    expect(femmeFataleRule.filterLegalMoves(
      context(
        "k7/8/8/8/8/8/4q3/4K3 b - - 0 1",
        { movesApplied: 0 },
        {},
        "black",
      ),
      [blackQueenCapture, { ...rookKingCapture, color: "black" }],
    )).toEqual([blackQueenCapture]);
  });
});

describe("Nurturer", () => {
  // drawback-evidence:nurturer:positive
  it("unlocks king capture permanently after any affected pawn promotion", () => {
    const initial: NurturerState = {
      movesApplied: 0,
      hasPromotedPawn: false,
    };
    for (const promotion of ["knight", "bishop", "rook", "queen"] as const) {
      const promoted = move("a7", "a8", "pawn", {
        promotion,
        flags: "promotion",
      });
      const unlocked = transition(
        nurturerRule,
        "4k3/P7/8/8/8/8/8/K7 w - - 0 1",
        `${promotion === "queen" ? "Q" : promotion === "rook" ? "R" : promotion === "bishop" ? "B" : "N"}3k3/8/8/8/8/8/8/K7 b - - 0 1`,
        initial,
        {},
        promoted,
      );
      expect(unlocked.hasPromotedPawn).toBe(true);
      expect(nurturerRule.filterLegalMoves(
        context(
          "4k3/4Q3/8/8/8/8/8/K7 w - - 0 2",
          unlocked,
          {},
        ),
        [queenKingCapture],
      )).toEqual([queenKingCapture]);
    }
  });

  // drawback-evidence:nurturer:negative
  it("rejects king capture before promotion without restricting other moves", () => {
    expect(nurturerRule.filterLegalMoves(
      context(
        "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
        { movesApplied: 0, hasPromotedPawn: false },
        {},
      ),
      [queenKingCapture, quietMove],
    )).toEqual([quietMove]);
  });

  // drawback-evidence:nurturer:promotion
  it("does not let a pawn's king capture satisfy its own promotion prerequisite", () => {
    const capturePromotion = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "queen",
      flags: "capture,promotion",
    });
    expect(nurturerRule.filterLegalMoves(
      context(
        "1k6/P7/8/8/8/8/8/K7 w - - 0 1",
        { movesApplied: 0, hasPromotedPawn: false },
        {},
      ),
      [capturePromotion],
    )).toEqual([]);
  });

  // drawback-evidence:nurturer:edge
  it("reconstructs only observed own promotion history and never resets", () => {
    const ownPromotion = move("a7", "a8", "pawn", {
      promotion: "queen",
      flags: "promotion",
    });
    const opponentPromotion = move("h2", "h1", "pawn", {
      color: "black",
      promotion: "queen",
      flags: "promotion",
    });
    expect(nurturerRule.initialize({
      color: "white",
      parameters: {},
      position: position(
        "Q3k3/8/8/8/8/8/8/K6q w - - 0 2",
        [ownPromotion, opponentPromotion],
      ),
    })).toEqual({
      movesApplied: 1,
      hasPromotedPawn: true,
    });
    expect(nurturerRule.initialize({
      color: "white",
      parameters: {},
      position: position(
        "4k3/8/8/8/8/8/8/K6q w - - 0 2",
        [opponentPromotion],
      ),
    }).hasPromotedPawn).toBe(false);

    const afterPromotedPieceCapture = transition(
      nurturerRule,
      "4k3/8/8/8/8/8/8/K7 w - - 0 2",
      "4k3/8/8/8/8/8/8/1K6 b - - 1 2",
      { movesApplied: 1, hasPromotedPawn: true },
      {},
      move("a1", "b1", "king"),
    );
    expect(afterPromotedPieceCapture.hasPromotedPawn).toBe(true);
  });
});

describe("Triple Play", () => {
  it("generates only the two piece types observed in source-site text", () => {
    expect(OBSERVED_TRIPLE_PLAY_TYPES).toEqual(["bishop", "knight"]);
    expect(triplePlayRule.generateParameters(
      new ScriptedRandom(0),
    )).toEqual({ requiredType: "bishop" });
    expect(triplePlayRule.generateParameters(
      new ScriptedRandom(0.75),
    )).toEqual({ requiredType: "knight" });
  });

  // drawback-evidence:triple-play:positive
  it("allows king capture while owning three or more required pieces", () => {
    for (const [requiredType, fen] of [
      [
        "knight",
        "4k3/4Q3/8/8/8/8/NNN5/K7 w - - 0 1",
      ],
      [
        "bishop",
        "4k3/4Q3/8/8/8/8/BBB5/K7 w - - 0 1",
      ],
      [
        "knight",
        "4k3/4Q3/8/8/8/N7/NNN5/K7 w - - 0 1",
      ],
    ] as const) {
      expect(triplePlayRule.filterLegalMoves(
        context(
          fen,
          { movesApplied: 0 },
          { requiredType } satisfies TriplePlayParameters,
        ),
        [queenKingCapture],
      )).toEqual([queenKingCapture]);
    }
  });

  // drawback-evidence:triple-play:negative
  it("rejects king capture with zero, one, or two required pieces", () => {
    for (const fen of [
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
      "4k3/4Q3/8/8/8/8/N7/K7 w - - 0 1",
      "4k3/4Q3/8/8/8/8/NN6/K7 w - - 0 1",
    ]) {
      expect(triplePlayRule.filterLegalMoves(
        context(
          fen,
          { movesApplied: 0 },
          { requiredType: "knight" },
        ),
        [queenKingCapture, quietMove],
      )).toEqual([quietMove]);
    }
  });

  // drawback-evidence:triple-play:promotion
  it("counts current promoted material but evaluates a king-capture promotion from the pre-move board", () => {
    expect(triplePlayRule.filterLegalMoves(
      context(
        "4k3/4Q3/8/8/8/8/BBB5/K7 w - - 0 1",
        { movesApplied: 2 },
        { requiredType: "bishop" },
      ),
      [queenKingCapture],
    )).toEqual([queenKingCapture]);
    const thirdBishopCapturePromotion = move("a7", "b8", "pawn", {
      captured: "king",
      promotion: "bishop",
      flags: "capture,promotion",
    });
    expect(triplePlayRule.filterLegalMoves(
      context(
        "1k6/P7/8/8/8/8/BB6/K7 w - - 0 1",
        { movesApplied: 0 },
        { requiredType: "bishop" },
      ),
      [thirdBishopCapturePromotion],
    )).toEqual([]);
  });

  // drawback-evidence:triple-play:edge
  it("uses only affected-color material and preserves ordinary moves", () => {
    const blackCapture = {
      ...queenKingCapture,
      color: "black" as const,
    };
    expect(triplePlayRule.filterLegalMoves(
      context(
        "k7/nnn5/8/8/8/8/4q3/4K3 b - - 0 1",
        { movesApplied: 0 },
        { requiredType: "knight" },
        "black",
      ),
      [blackCapture, { ...quietMove, color: "black" }],
    )).toHaveLength(2);
    expect(triplePlayRule.filterLegalMoves(
      context(
        "4k3/4Q3/8/8/8/8/nnn5/K7 w - - 0 1",
        { movesApplied: 0 },
        { requiredType: "knight" },
      ),
      [queenKingCapture, quietMove],
    )).toEqual([quietMove]);
  });
});

describe("You Best Not Miss", () => {
  const clear: YouBestNotMissState = {
    movesApplied: 0,
    mustCaptureKingNextTurn: false,
  };

  // drawback-evidence:you-best-not-miss:positive
  it("records quiet, capture, discovered, promotion, castling, and en-passant checks", () => {
    const cases = [
      {
        before: "7k/8/8/8/8/8/8/R3K3 w - - 0 1",
        after: "R6k/8/8/8/8/8/8/4K3 b - - 1 1",
        selected: move("a1", "a8", "rook"),
      },
      {
        before: "r6k/8/8/8/8/8/8/R3K3 w - - 0 1",
        after: "R6k/8/8/8/8/8/8/4K3 b - - 0 1",
        selected: move("a1", "a8", "rook", { captured: "rook" }),
      },
      {
        before: "4k3/8/8/8/8/8/4B3/4R2K w - - 0 1",
        after: "4k3/8/8/7B/8/8/8/4R2K b - - 1 1",
        selected: move("e2", "h5", "bishop"),
      },
      {
        before: "k7/6P1/8/8/8/8/8/7K w - - 0 1",
        after: "k5R1/8/8/8/8/8/8/7K b - - 0 1",
        selected: move("g7", "g8", "pawn", {
          promotion: "rook",
          flags: "promotion",
        }),
      },
      {
        before: "5k2/8/8/8/8/8/8/4K2R w K - 0 1",
        after: "5k2/8/8/8/8/8/8/5RK1 b - - 1 1",
        selected: move("e1", "g1", "king", {
          flags: "kingside-castle",
        }),
      },
      {
        before: "4k3/8/8/3pP3/8/8/8/4R2K w - d6 0 1",
        after: "4k3/8/3P4/8/8/8/8/4R2K b - - 0 1",
        selected: move("e5", "d6", "pawn", {
          captured: "pawn",
          flags: "capture,en-passant",
        }),
      },
    ];
    for (const example of cases) {
      expect(transition(
        youBestNotMissRule,
        example.before,
        example.after,
        clear,
        {},
        example.selected,
      ).mustCaptureKingNextTurn).toBe(true);
    }
  });

  // drawback-evidence:you-best-not-miss:negative
  it("does not arm after a move that leaves the opposing king unattacked", () => {
    const state = transition(
      youBestNotMissRule,
      "7k/8/8/8/8/8/8/R3K3 w - - 0 1",
      "7k/8/8/8/8/8/R7/4K3 b - - 1 1",
      clear,
      {},
      move("a1", "a2", "rook"),
    );
    expect(state).toEqual({
      movesApplied: 1,
      mustCaptureKingNextTurn: false,
    });
  });

  // drawback-evidence:you-best-not-miss:edge
  it("retains only literal king captures while the delayed obligation is armed", () => {
    const armed: YouBestNotMissState = {
      movesApplied: 1,
      mustCaptureKingNextTurn: true,
    };
    const moves = [
      queenKingCapture,
      rookKingCapture,
      move("e7", "e8", "queen", { captured: "rook" }),
      quietMove,
    ];
    expect(youBestNotMissRule.filterLegalMoves(
      context(
        "4k3/4Q3/8/8/8/8/8/K7 w - - 0 2",
        armed,
        {},
      ),
      moves,
    )).toEqual([queenKingCapture, rookKingCapture]);
    expect(youBestNotMissRule.filterLegalMoves(
      context(
        "4k3/8/8/8/8/8/8/K7 w - - 0 2",
        armed,
        {},
      ),
      [quietMove],
    )).toEqual([]);
  });

  it("does not treat a literal terminal king capture as a new check obligation", () => {
    const after = transition(
      youBestNotMissRule,
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
      "4Q3/8/8/8/8/8/8/K7 b - - 0 1",
      {
        movesApplied: 1,
        mustCaptureKingNextTurn: true,
      },
      {},
      queenKingCapture,
    );
    expect(after).toEqual({
      movesApplied: 2,
      mustCaptureKingNextTurn: false,
    });
  });
});
