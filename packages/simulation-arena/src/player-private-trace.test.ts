import { describe, expect, it } from "vitest";
import {
  encodePlayerPrivateSimulationTraceRecord,
  parsePlayerPrivateSimulationTraceRecord,
} from "@drawbackengine/simulation-trace";
import { DrawbackGameSession } from "@drawbackengine/chess-core";
import type { ChessMove } from "@drawbackengine/drawback-engine";
import {
  auditedUniformOpponentHypotheses,
  createPlayerPrivateSimulationTrace,
  createSimulationRandomStreams,
  PLAYER_PRIVATE_RULE_IDS,
  resolvePlayerPrivateRule,
  simulatePlayerPrivateGame,
  type PlayerPrivateAgentView,
  type PlayerPrivateSimulationAgent,
} from "./index.js";

const scriptedSearchAgent: PlayerPrivateSimulationAgent = Object.freeze({
  id: "trace-scripted-search",
  style: "drawback-search",
  strength: 1_200,
  searchPolicy: Object.freeze({
    policyId: "trace-scripted-search/v1",
    evaluatorId: "drawback-material/v1",
    maxDepth: 1,
    maxNodes: 2_000,
    leafCacheEntries: 1_024,
    leafCacheHistoryMode: "full",
    temperatureCp: 1,
    topK: 1,
  }),
  chooseMove(view: PlayerPrivateAgentView) {
    const scripted =
      view.ply === 0
        ? matchingMove(view, "e1", "g1")
        : view.ply === 1
          ? matchingMove(view, "f8", "f1")
          : undefined;
    const move = scripted ?? view.legalMoves[0];
    if (move === undefined) {
      throw new Error("Expected a player-private legal move.");
    }
    return Promise.resolve(move);
  },
});

describe("player-private simulation trace v1", () => {
  it("round-trips a castling king-passant capture with full authority state", async () => {
    const vegan = resolvePlayerPrivateRule("vegan");
    const game = await simulatePlayerPrivateGame({
      seed: 0x1234_5678,
      fen: "5r1k/8/8/8/8/8/8/4K2R w K - 0 1",
      maxPlies: 2,
      rules: { white: vegan, black: vegan },
      whiteAgent: scriptedSearchAgent,
      blackAgent: scriptedSearchAgent,
    });
    const trace = createPlayerPrivateSimulationTrace(game, 7);
    const encoded = encodePlayerPrivateSimulationTraceRecord(trace);

    expect(trace.plies[0]?.positionAfter.kingPassant).toEqual({
      victim: "white",
      kingSquare: "g1",
      targets: ["f1"],
    });
    expect(trace.result).toEqual({
      kind: "king-capture",
      winner: "black",
      capturedKing: "white",
      method: "castling-en-passant",
    });
    expect(parsePlayerPrivateSimulationTraceRecord(
      JSON.parse(encoded) as unknown,
    )).toEqual(trace);
    expect(encodePlayerPrivateSimulationTraceRecord(trace)).toBe(encoded);
  });

  it("rejects tampered authority masks, secret state, provenance, and results", async () => {
    const truant = resolvePlayerPrivateRule("truant");
    const game = await simulatePlayerPrivateGame({
      seed: 73,
      maxPlies: 3,
      rules: {
        white: truant,
        black: resolvePlayerPrivateRule("vegan"),
      },
      whiteAgent: statefulScriptedAgent,
      blackAgent: statefulScriptedAgent,
    });
    const trace = createPlayerPrivateSimulationTrace(game, 0);
    const first = trace.plies[0];
    const third = trace.plies[2];
    if (first === undefined || third === undefined) {
      throw new Error("Expected three trace plies.");
    }

    expect(() => parsePlayerPrivateSimulationTraceRecord({
      ...trace,
      plies: [{
        ...first,
        authorityLegalMoves: first.authorityLegalMoves.slice(1),
      }, ...trace.plies.slice(1)],
    })).toThrow();
    expect(() => parsePlayerPrivateSimulationTraceRecord({
      ...trace,
      plies: [
        ...trace.plies.slice(0, 2),
        {
          ...third,
          activeSecret: {
            ...third.activeSecret,
            drawbackInternalState: { forged: true },
          },
        },
      ],
    })).toThrow("does not match exact replay");
    expect(() => parsePlayerPrivateSimulationTraceRecord({
      ...trace,
      agents: {
        ...trace.agents,
        white: {
          ...trace.agents.white,
          searchPolicy: {
            ...trace.agents.white.searchPolicy,
            maxNodes: 1,
          },
        },
      },
    })).toThrow("at least 2");
    expect(() => parsePlayerPrivateSimulationTraceRecord({
      ...trace,
      parameterSeeds: {
        ...trace.parameterSeeds,
        white: (trace.parameterSeeds.white + 1) >>> 0,
      },
    })).toThrow("gameId does not match");
    expect(() => parsePlayerPrivateSimulationTraceRecord({
      ...trace,
      result: {
        kind: "king-capture",
        winner: "white",
        capturedKing: "black",
        method: "direct",
      },
      stoppedAtPlyLimit: false,
    })).toThrow("does not match exact replay");
  });

  it("keeps the orthodox trace parser and new authority contract disjoint", async () => {
    const vegan = resolvePlayerPrivateRule("vegan");
    const game = await simulatePlayerPrivateGame({
      seed: 9,
      maxPlies: 1,
      rules: { white: vegan, black: vegan },
      whiteAgent: statefulScriptedAgent,
      blackAgent: statefulScriptedAgent,
    });
    const trace = createPlayerPrivateSimulationTrace(game, 1);
    const standardParser = await import("@drawbackengine/simulation-trace");
    expect(() =>
      standardParser.parsePrivateSimulationTraceRecord(trace)
    ).toThrow();
  });

  it("round-trips audited-opponent provenance and rejects unknown policies", async () => {
    const vegan = resolvePlayerPrivateRule("vegan");
    const game = await simulatePlayerPrivateGame({
      seed: 0xa0d1_7ed,
      maxPlies: 2,
      rules: { white: vegan, black: vegan },
      whiteAgent: statefulScriptedAgent,
      blackAgent: statefulScriptedAgent,
      opponentHypotheses: auditedUniformOpponentHypotheses,
    });
    const trace = createPlayerPrivateSimulationTrace(game, 2);

    expect(trace.hypothesisPolicy).toEqual({
      kind: "audited-uniform",
      version: 1,
    });
    expect(
      parsePlayerPrivateSimulationTraceRecord(
        JSON.parse(
          encodePlayerPrivateSimulationTraceRecord(trace),
        ) as unknown,
      ),
    ).toEqual(trace);
    expect(() =>
      parsePlayerPrivateSimulationTraceRecord({
        ...trace,
        hypothesisPolicy: {
          kind: "unknown",
          version: 1,
        },
      })
    ).toThrow("hypothesisPolicy is unsupported");
  });

  it(
    "round-trips deterministic generated games across every audited rule",
    async () => {
      for (
        let index = 0;
        index < PLAYER_PRIVATE_RULE_IDS.length;
        index += 1
      ) {
        const whiteId = PLAYER_PRIVATE_RULE_IDS[index];
        const blackId =
          PLAYER_PRIVATE_RULE_IDS[
            (index * 3 + 1) % PLAYER_PRIVATE_RULE_IDS.length
          ];
        if (whiteId === undefined || blackId === undefined) {
          throw new Error("Expected audited rule IDs.");
        }
        const game = await simulatePlayerPrivateGame({
          seed: (0x9e37_79b9 ^ index) >>> 0,
          maxPlies: 4,
          rules: {
            white: resolvePlayerPrivateRule(whiteId),
            black: resolvePlayerPrivateRule(blackId),
          },
          whiteAgent: statefulScriptedAgent,
          blackAgent: statefulScriptedAgent,
        });
        const fresh = DrawbackGameSession.create(
          {
            white: resolvePlayerPrivateRule(whiteId),
            black: resolvePlayerPrivateRule(blackId),
          },
          createSimulationRandomStreams(
            (0x9e37_79b9 ^ index) >>> 0,
          ).parameters,
        );
        expect(fresh.exportSecretSnapshot()).toEqual(
          game.drawbackSecrets.initial,
        );
        let trace;
        try {
          trace = createPlayerPrivateSimulationTrace(game, index);
        } catch (error: unknown) {
          throw new Error(
            `Trace round-trip failed for ${whiteId} versus ${blackId} at generated case ${String(index)}.`,
            { cause: error },
          );
        }
        const encoded = encodePlayerPrivateSimulationTraceRecord(trace);
        expect(
          encodePlayerPrivateSimulationTraceRecord(
            parsePlayerPrivateSimulationTraceRecord(
              JSON.parse(encoded) as unknown,
            ),
          ),
        ).toBe(encoded);
      }
    },
    30_000,
  );
});

const statefulScriptedAgent: PlayerPrivateSimulationAgent = Object.freeze({
  ...scriptedSearchAgent,
  id: "stateful-trace-script",
  chooseMove(view: PlayerPrivateAgentView) {
    const scripted =
      view.ply === 0
        ? matchingMove(view, "e2", "e4")
        : view.ply === 1
          ? matchingMove(view, "a7", "a6")
          : undefined;
    const move = scripted ?? view.legalMoves[0];
    if (move === undefined) {
      throw new Error("Expected a player-private legal move.");
    }
    return Promise.resolve(move);
  },
});

function matchingMove(
  view: PlayerPrivateAgentView,
  from: string,
  to: string,
): ChessMove | undefined {
  return view.legalMoves.find(
    (move) => move.from === from && move.to === to,
  );
}
