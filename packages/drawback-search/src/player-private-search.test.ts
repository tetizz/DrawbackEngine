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
import { unrestrictedRule } from "@drawbackengine/drawback-engine";
import { Mulberry32, type PlayerColor } from "@drawbackengine/shared";
import { drawbackMaterialEvaluator } from "./material-evaluator.js";
import {
  createOwnPlayerRuleCapability,
  createPublicDrawbackHypothesis,
} from "./player-private-capability.js";
import { searchPlayerPrivateDrawbackMove } from "./player-private-search.js";

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
});

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
