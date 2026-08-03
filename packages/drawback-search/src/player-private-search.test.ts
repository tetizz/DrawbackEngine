import { describe, expect, it } from "vitest";
import {
  CapturableKingPosition,
  createPublicGameTrace,
  inspectPublicGameTrace,
  replayPublicGameTrace,
  type PublicGameTrace,
} from "@drawbackengine/chess-core";
import type {
  ChessMove,
  DrawbackRule,
  PositionView,
} from "@drawbackengine/drawback-engine";
import {
  checkersRule,
  lameDuckRule,
  unrestrictedRule,
} from "@drawbackengine/drawback-engine";
import { Mulberry32, type PlayerColor } from "@drawbackengine/shared";
import { drawbackMaterialEvaluator } from "./material-evaluator.js";
import type { DrawbackLeafEvaluator } from "./types.js";
import {
  createOwnPlayerRuleCapability,
  createPublicDrawbackHypothesis,
} from "./player-private-capability.js";
import {
  searchPlayerPrivateDrawbackMove,
  searchPlayerPrivateDrawbackRootMove,
  type PlayerPrivateSearchInput,
} from "./player-private-search.js";

const noKingCaptureRule: DrawbackRule<
  Record<string, never>,
  Record<string, never>
> = {
  id: "test-no-king-capture",
  name: "No king capture",
  description: "Test rule that filters literal king captures.",
  verification: "verified",
  supportedAuthorities: ["capturable-king/v1"],
  generateParameters: () => ({}),
  initialize: () => ({}),
  filterLegalMoves: (_context, moves) =>
    moves.filter((move) => move.captured !== "king"),
  applyMove: () => ({}),
  checkStartOfTurnLoss: () => null,
};

const alwaysLoseRule: DrawbackRule<
  Record<string, never>,
  Record<string, never>
> = {
  id: "test-always-lose",
  name: "Always lose",
  description: "Test rule with an immediate start-of-turn loss.",
  verification: "verified",
  supportedAuthorities: ["capturable-king/v1"],
  generateParameters: () => ({}),
  initialize: () => ({}),
  filterLegalMoves: (_context, moves) => [...moves],
  applyMove: () => ({}),
  checkStartOfTurnLoss: (context) => ({
    ruleId: "test-always-lose",
    color: context.color,
    reason: "Test terminal world.",
  }),
};

const rewardedRookMoveEvaluator: DrawbackLeafEvaluator = {
  id: "test-reward-h1h2/v1",
  evaluate(position) {
    const rootMove = position.history[0];
    const whiteScore =
      rootMove?.from === "h1" && rootMove.to === "h2" ? 20_000 : 0;
    return Promise.resolve(
      position.turn === "white" ? whiteScore : -whiteScore,
    );
  },
};

const POISONED_ROOK_FEN =
  "4k3/3r4/8/8/8/8/8/3QK3 w - - 0 1";
const HORIZON_REGRESSION_LIMITS = { depth: 1, maxNodes: 20_000 } as const;

describe("searchPlayerPrivateDrawbackMove", () => {
  it("recognizes literal king capture as an immediate win", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    );
    const result = await searchPlayerPrivateDrawbackMove({
      trace: createPublicGameTrace(position.snapshot()),
      own: ownCapability("white", unrestrictedRule, position),
      opponent: [
        publicHypothesis(
          "unrestricted-black",
          1,
          "black",
          unrestrictedRule,
          position,
        ),
      ],
      aggregation: "worst-case",
      evaluator: drawbackMaterialEvaluator,
      limits: { depth: 2, maxNodes: 2_000 },
    });

    expect(result.move).toMatchObject({
      from: "e7",
      to: "e8",
      captured: "king",
    });
    expect(result.score).toBeGreaterThan(900_000);
    expect(result.knowledgeMode).toBe("player-private");
  });

  it("lets the exact own drawback forbid a king capture", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/4Q3/8/8/8/8/8/K7 w - - 0 1",
    );
    const result = await searchPlayerPrivateDrawbackMove({
      trace: createPublicGameTrace(position.snapshot()),
      own: ownCapability("white", noKingCaptureRule, position),
      opponent: [
        publicHypothesis(
          "unrestricted-black",
          1,
          "black",
          unrestrictedRule,
          position,
        ),
      ],
      aggregation: "worst-case",
      evaluator: drawbackMaterialEvaluator,
      limits: { depth: 1, maxNodes: 2_000 },
    });

    expect(result.move.captured).not.toBe("king");
    expect(result.score).toBeLessThan(900_000);
  });

  it("defends against a king capture allowed by any live opponent hypothesis", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/8/8/8/8/8/4q3/4K2R w - - 0 1",
    );
    const result = await searchPlayerPrivateDrawbackMove({
      trace: createPublicGameTrace(position.snapshot()),
      own: ownCapability("white", unrestrictedRule, position),
      opponent: [
        publicHypothesis(
          "black-can-capture",
          0.5,
          "black",
          unrestrictedRule,
          position,
        ),
        publicHypothesis(
          "black-cannot-capture",
          0.5,
          "black",
          noKingCaptureRule,
          position,
        ),
      ],
      aggregation: "worst-case",
      evaluator: drawbackMaterialEvaluator,
      limits: { depth: 2, maxNodes: 5_000 },
    });

    expect(result.move).toMatchObject({
      from: "e1",
      to: "e2",
      captured: "queen",
    });
    expect(result.opponentHypothesisCount).toBe(2);
  });

  it("avoids a one-ply poisoned capture under every posterior aggregation", async () => {
    for (
      const aggregation of [
        "worst-case",
        "posterior-expected",
        "posterior-cvar-25",
      ] as const
    ) {
      const position = CapturableKingPosition.fromFen(POISONED_ROOK_FEN);
      const result = await searchPlayerPrivateDrawbackMove({
        trace: createPublicGameTrace(position.snapshot()),
        own: ownCapability("white", unrestrictedRule, position),
        opponent: [
          publicHypothesis(
            "unrestricted-black",
            1,
            "black",
            unrestrictedRule,
            position,
          ),
        ],
        aggregation,
        evaluator: drawbackMaterialEvaluator,
        limits: HORIZON_REGRESSION_LIMITS,
      });

      expect(result.move).toMatchObject({ from: "d1", to: "a1" });
      expect(result.score).toBe(400);
      expect(result.truncated).toBe(false);
    }
  });

  it("keeps the capture when the reconstructed drawback forbids recapture", async () => {
    const position = CapturableKingPosition.fromFen(POISONED_ROOK_FEN);
    const result = await searchPlayerPrivateDrawbackMove({
      trace: createPublicGameTrace(position.snapshot()),
      own: ownCapability("white", unrestrictedRule, position),
      opponent: [
        publicHypothesis(
          "lame-duck-black",
          1,
          "black",
          lameDuckRule,
          position,
        ),
      ],
      aggregation: "posterior-expected",
      evaluator: drawbackMaterialEvaluator,
      limits: HORIZON_REGRESSION_LIMITS,
    });

    expect(result.move).toMatchObject({
      from: "d1",
      to: "d7",
      captured: "rook",
    });
    expect(result.score).toBeGreaterThan(900_000);
  });

  it("never stands pat when every live world forces a capture", async () => {
    const searchRoot = async (
      aggregation: PlayerPrivateSearchInput["aggregation"],
      maxNodes: number,
    ) => {
      const position = CapturableKingPosition.fromFen(POISONED_ROOK_FEN);
      const root = position.legalMoves().find(
        (move) => move.from === "d1" && move.to === "d7",
      );
      if (root === undefined) {
        throw new Error("Expected Qxd7 to be authority-legal.");
      }
      const result = await searchPlayerPrivateDrawbackRootMove(
        {
          trace: createPublicGameTrace(position.snapshot()),
          own: ownCapability("white", unrestrictedRule, position),
          opponent: [
            publicHypothesis(
              "checkers-black",
              1,
              "black",
              checkersRule,
              position,
            ),
          ],
          aggregation,
          evaluator: drawbackMaterialEvaluator,
          limits: { depth: 1, maxNodes },
        },
        root,
      );
      return { result, root };
    };

    for (
      const aggregation of [
        "worst-case",
        "posterior-expected",
        "posterior-cvar-25",
      ] as const
    ) {
      const bounded = await searchRoot(aggregation, 2);
      expect(bounded.result).toMatchObject({
        score: -999_998,
        nodes: 2,
        truncated: true,
      });
      expect(bounded.result.principalVariation).toEqual([
        bounded.root,
        expect.objectContaining({
          from: "e8",
          to: "d7",
          captured: "queen",
        }),
      ]);

      const exact = await searchRoot(aggregation, 3);
      expect(exact.result).toMatchObject({
        score: 0,
        nodes: 3,
        truncated: false,
      });
    }
  });

  it("bounds only the forced worlds in a mixed posterior", async () => {
    const searchRoot = async (maxNodes: number) => {
      const position = CapturableKingPosition.fromFen(POISONED_ROOK_FEN);
      const root = position.legalMoves().find(
        (move) => move.from === "d1" && move.to === "d7",
      );
      if (root === undefined) {
        throw new Error("Expected Qxd7 to be authority-legal.");
      }
      const result = await searchPlayerPrivateDrawbackRootMove(
        {
          trace: createPublicGameTrace(position.snapshot()),
          own: ownCapability("white", unrestrictedRule, position),
          opponent: [
            publicHypothesis(
              "checkers-black",
              0.5,
              "black",
              checkersRule,
              position,
            ),
            publicHypothesis(
              "unrestricted-black",
              0.5,
              "black",
              unrestrictedRule,
              position,
            ),
          ],
          aggregation: "posterior-expected",
          evaluator: drawbackMaterialEvaluator,
          limits: { depth: 1, maxNodes },
        },
        root,
      );
      return { result, root };
    };

    const bounded = await searchRoot(2);
    expect(bounded.result).toMatchObject({
      score: -499_549,
      nodes: 2,
      truncated: true,
    });
    expect(bounded.result.principalVariation).toEqual([
      bounded.root,
      expect.objectContaining({ from: "e8", to: "d7" }),
    ]);

    const exact = await searchRoot(3);
    expect(exact.result).toMatchObject({
      score: 0,
      nodes: 3,
      truncated: false,
    });
  });

  it("preserves special castling king-passant in the public snapshot", async () => {
    const position = CapturableKingPosition.fromFen(
      "5r1k/8/8/8/8/8/8/4K2R w K - 0 1",
    );
    const origin = position.snapshot();
    const castle = position.move({ from: "e1", to: "g1" });
    expect(castle?.terminal).toBeNull();
    const history = castle === null ? [] : [castle.move];
    const trace = replayPublicGameTrace(origin, history, position.snapshot());

    const result = await searchPlayerPrivateDrawbackMove({
      trace,
      own: ownCapability("black", unrestrictedRule, position, history),
      opponent: [
        publicHypothesis(
          "unrestricted-white",
          1,
          "white",
          unrestrictedRule,
          position,
          trace,
        ),
      ],
      aggregation: "worst-case",
      evaluator: drawbackMaterialEvaluator,
      limits: { depth: 1, maxNodes: 500 },
    });

    expect(result.move).toMatchObject({
      from: "f8",
      to: "f1",
      captured: "king",
    });
    expect(result.move.flags).toContain("king-en-passant");
    expect(result.score).toBeGreaterThan(900_000);
  });

  it("is deterministic and does not expose rule parameters or state", async () => {
    const position = CapturableKingPosition.fromFen();
    const input = {
      trace: createPublicGameTrace(position.snapshot()),
      own: ownCapability("white", unrestrictedRule, position),
      opponent: [
        publicHypothesis(
          "unrestricted-black",
          1,
          "black",
          unrestrictedRule,
          position,
        ),
      ],
      aggregation: "worst-case" as const,
      evaluator: drawbackMaterialEvaluator,
      limits: { depth: 2, maxNodes: 1_000 },
    };

    const first = await searchPlayerPrivateDrawbackMove(input);
    const second = await searchPlayerPrivateDrawbackMove(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(
      /parameters|internalState|secret|trueDrawback/u,
    );
    expect(position.turn).toBe("white");
    expect(position.fen).toBe(inspectPublicGameTrace(input.trace).current.fen);
  });

  it("rejects structurally forged own and opponent capabilities", async () => {
    const position = CapturableKingPosition.fromFen();
    const genuineOwn = ownCapability("white", unrestrictedRule, position);
    const genuineOpponent = publicHypothesis(
      "unrestricted-black",
      1,
      "black",
      unrestrictedRule,
      position,
    );
    const base = {
      trace: createPublicGameTrace(position.snapshot()),
      aggregation: "worst-case" as const,
      evaluator: drawbackMaterialEvaluator,
      limits: { depth: 1, maxNodes: 100 },
    };

    await expect(searchPlayerPrivateDrawbackMove({
      ...base,
      own: { ...genuineOwn },
      opponent: [genuineOpponent],
    })).rejects.toThrow("Own rule capability was not minted");
    await expect(searchPlayerPrivateDrawbackMove({
      ...base,
      own: genuineOwn,
      opponent: [{
        ...genuineOpponent,
        capability: { ...genuineOpponent.capability },
      }],
    })).rejects.toThrow("Opponent hypothesis capability was not reconstructed");
  });

  it("uses posterior mass instead of letting a rare permissive world dominate", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/8/8/8/8/8/4q3/4K2R w - - 0 1",
    );
    const opponent = [
      publicHypothesis(
        "rare-king-capture",
        0.001,
        "black",
        unrestrictedRule,
        position,
      ),
      publicHypothesis(
        "likely-no-king-capture",
        0.999,
        "black",
        noKingCaptureRule,
        position,
      ),
    ];
    const context = {
      trace: createPublicGameTrace(position.snapshot()),
      own: ownCapability("white", unrestrictedRule, position),
      opponent,
      evaluator: rewardedRookMoveEvaluator,
      limits: { depth: 2, maxNodes: 10_000 },
    };

    const worstCase = await searchPlayerPrivateDrawbackMove({
      ...context,
      aggregation: "worst-case",
    });
    const expected = await searchPlayerPrivateDrawbackMove({
      ...context,
      aggregation: "posterior-expected",
    });

    expect(worstCase.move).not.toMatchObject({ from: "h1", to: "h2" });
    expect(expected.move).toMatchObject({ from: "h1", to: "h2" });
    expect(expected.score).toBeCloseTo(18_980.002, 6);
    expect(expected.aggregation).toBe("posterior-expected");
  });

  it("uses the worst posterior quartile to reject a low-probability catastrophe", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/8/8/8/8/8/4q3/4K2R w - - 0 1",
    );
    const opponent = [
      publicHypothesis(
        "one-percent-king-capture",
        0.01,
        "black",
        unrestrictedRule,
        position,
      ),
      publicHypothesis(
        "likely-no-king-capture",
        0.99,
        "black",
        noKingCaptureRule,
        position,
      ),
    ];
    const context = {
      trace: createPublicGameTrace(position.snapshot()),
      own: ownCapability("white", unrestrictedRule, position),
      opponent,
      evaluator: rewardedRookMoveEvaluator,
      limits: { depth: 2, maxNodes: 10_000 },
    };

    const expected = await searchPlayerPrivateDrawbackMove({
      ...context,
      aggregation: "posterior-expected",
    });
    const cvar = await searchPlayerPrivateDrawbackMove({
      ...context,
      aggregation: "posterior-cvar-25",
    });

    expect(expected.move).toMatchObject({ from: "h1", to: "h2" });
    expect(cvar.move).not.toMatchObject({ from: "h1", to: "h2" });
    expect(cvar.aggregation).toBe("posterior-cvar-25");
  });

  it("computes posterior-cvar-25 from the exact worst-mass boundary", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/8/8/8/8/8/4q3/4K2R w - - 0 1",
    );
    for (const depth of [1, 2]) {
      const result = await searchPlayerPrivateDrawbackRootMove(
        {
          trace: createPublicGameTrace(position.snapshot()),
          own: ownCapability("white", unrestrictedRule, position),
          opponent: [
            publicHypothesis(
              "king-capture",
              0.1,
              "black",
              unrestrictedRule,
              position,
            ),
            publicHypothesis(
              "no-king-capture",
              0.9,
              "black",
              noKingCaptureRule,
              position,
            ),
          ],
          aggregation: "posterior-cvar-25",
          evaluator: {
            id: "test-zero/v1",
            evaluate: () => Promise.resolve(0),
          },
          limits: { depth, maxNodes: 10_000 },
        },
        { from: "h1", to: "h2" },
      );

      expect(result.score).toBeCloseTo(-399_999.2, 6);
      expect(result.principalVariation.slice(0, 2)).toMatchObject([
        { from: "h1", to: "h2" },
        { from: "e2", to: "e1", captured: "king" },
      ]);
    }
  });

  it("does not count likely opponent-loss worlds as lower-tail reward", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/8/8/8/8/8/4q3/4K2R w - - 0 1",
    );
    const result = await searchPlayerPrivateDrawbackRootMove(
      {
        trace: createPublicGameTrace(position.snapshot()),
        own: ownCapability("white", unrestrictedRule, position),
        opponent: [
          publicHypothesis(
            "terminal-world",
            0.25,
            "black",
            alwaysLoseRule,
            position,
          ),
          publicHypothesis(
            "live-world",
            0.75,
            "black",
            noKingCaptureRule,
            position,
          ),
        ],
        aggregation: "posterior-cvar-25",
        evaluator: {
          id: "test-zero/v1",
          evaluate: () => Promise.resolve(0),
        },
        limits: { depth: 2, maxNodes: 10_000 },
      },
      { from: "h1", to: "h2" },
    );

    expect(result.score).toBe(0);
  });

  it("changes an exact root score when posterior mass is swapped", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/8/8/8/8/8/4q3/4K2R w - - 0 1",
    );
    const scoreAt = async (kingCaptureProbability: number) =>
      searchPlayerPrivateDrawbackRootMove(
        {
          trace: createPublicGameTrace(position.snapshot()),
          own: ownCapability("white", unrestrictedRule, position),
          opponent: [
            publicHypothesis(
              "king-capture",
              kingCaptureProbability,
              "black",
              unrestrictedRule,
              position,
            ),
            publicHypothesis(
              "no-king-capture",
              1 - kingCaptureProbability,
              "black",
              noKingCaptureRule,
              position,
            ),
          ],
          aggregation: "posterior-expected",
          evaluator: {
            id: "test-zero/v1",
            evaluate: () => Promise.resolve(0),
          },
          limits: { depth: 2, maxNodes: 10_000 },
        },
        { from: "h1", to: "h2" },
      );

    const lowRisk = await scoreAt(0.1);
    const highRisk = await scoreAt(0.9);
    expect(lowRisk.score).toBeCloseTo(-99_999.8, 6);
    expect(highRisk.score).toBeCloseTo(-899_998.2, 6);
    expect(lowRisk.score).toBeGreaterThan(highRisk.score);
  });

  it("counts start-of-turn loss probability instead of dropping it", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/8/8/8/8/8/4q3/4K2R w - - 0 1",
    );
    const result = await searchPlayerPrivateDrawbackRootMove(
      {
        trace: createPublicGameTrace(position.snapshot()),
        own: ownCapability("white", unrestrictedRule, position),
        opponent: [
          publicHypothesis(
            "terminal-world",
            0.25,
            "black",
            alwaysLoseRule,
            position,
          ),
          publicHypothesis(
            "live-world",
            0.75,
            "black",
            noKingCaptureRule,
            position,
          ),
        ],
        aggregation: "posterior-expected",
        evaluator: {
          id: "test-zero/v1",
          evaluate: () => Promise.resolve(0),
        },
        limits: { depth: 2, maxNodes: 10_000 },
      },
      { from: "h1", to: "h2" },
    );

    expect(result.score).toBeCloseTo(249_999.75, 6);
  });

  it("uses a deterministic coordinate tie-break for representative PVs", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/8/8/8/8/8/4q3/4K2R w - - 0 1",
    );
    const result = await searchPlayerPrivateDrawbackRootMove(
      {
        trace: createPublicGameTrace(position.snapshot()),
        own: ownCapability("white", unrestrictedRule, position),
        opponent: [
          publicHypothesis(
            "a2-only",
            0.5,
            "black",
            onlyMoveRule("test-a2-only", "e2", "a2"),
            position,
          ),
          publicHypothesis(
            "b2-only",
            0.5,
            "black",
            onlyMoveRule("test-b2-only", "e2", "b2"),
            position,
          ),
        ],
        aggregation: "posterior-expected",
        evaluator: {
          id: "test-zero/v1",
          evaluate: () => Promise.resolve(0),
        },
        limits: { depth: 2, maxNodes: 10_000 },
      },
      { from: "h1", to: "h2" },
    );

    expect(result.principalVariation.slice(0, 2)).toMatchObject([
      { from: "h1", to: "h2" },
      { from: "e2", to: "a2" },
    ]);
  });

  it("evaluates exact world masks at an opponent depth boundary", async () => {
    const position = CapturableKingPosition.fromFen(
      "4k3/8/8/8/8/8/4q3/4K2R w - - 0 1",
    );
    const evaluatedMasks: string[][] = [];

    await searchPlayerPrivateDrawbackRootMove(
      {
        trace: createPublicGameTrace(position.snapshot()),
        own: ownCapability("white", unrestrictedRule, position),
        opponent: [
          publicHypothesis(
            "a2-only",
            0.5,
            "black",
            onlyMoveRule("test-leaf-a2-only", "e2", "a2"),
            position,
          ),
          publicHypothesis(
            "b2-only",
            0.5,
            "black",
            onlyMoveRule("test-leaf-b2-only", "e2", "b2"),
            position,
          ),
        ],
        aggregation: "posterior-expected",
        evaluator: {
          id: "test-mask-observer/v1",
          evaluate(leaf) {
            evaluatedMasks.push(
              leaf.legalMoves.map((move) => `${move.from}${move.to}`),
            );
            return Promise.resolve(0);
          },
        },
        limits: { depth: 1, maxNodes: 10_000 },
      },
      { from: "h1", to: "h2" },
    );

    expect(evaluatedMasks).toEqual([
      ["e2a2"],
      ["e2b2"],
    ]);
  });
});

function onlyMoveRule(
  id: string,
  from: string,
  to: string,
): DrawbackRule<Record<string, never>, Record<string, never>> {
  return {
    id,
    name: id,
    description: `Test rule permitting only ${from}${to}.`,
    verification: "verified",
    supportedAuthorities: ["capturable-king/v1"],
    generateParameters: () => ({}),
    initialize: () => ({}),
    filterLegalMoves: (_context, moves) =>
      moves.filter((move) => move.from === from && move.to === to),
    applyMove: () => ({}),
    checkStartOfTurnLoss: () => null,
  };
}

function ownCapability<State, Parameters>(
  color: PlayerColor,
  rule: DrawbackRule<State, Parameters>,
  position: CapturableKingPosition,
  history: readonly ChessMove[] = [],
) {
  const parameters = rule.generateParameters(new Mulberry32(1));
  const view: PositionView = {
    fen: position.fen,
    turn: position.turn,
    ply: history.length,
    history,
  };
  return createOwnPlayerRuleCapability(
    "capturable-king/v1",
    color,
    rule,
    parameters,
    rule.initialize({ color, parameters, position: view }),
    view,
  );
}

function publicHypothesis<State, Parameters>(
  hypothesisId: string,
  probability: number,
  color: PlayerColor,
  rule: DrawbackRule<State, Parameters>,
  position: CapturableKingPosition,
  trace: PublicGameTrace = createPublicGameTrace(position.snapshot()),
) {
  const parameters = rule.generateParameters(new Mulberry32(1));
  return createPublicDrawbackHypothesis(
    hypothesisId,
    probability,
    color,
    rule,
    parameters,
    trace,
  );
}
