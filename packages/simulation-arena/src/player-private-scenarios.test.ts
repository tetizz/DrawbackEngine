import { describe, expect, it } from "vitest";
import {
  CapturableKingPosition,
} from "@drawbackengine/chess-core";
import {
  drawbackMaterialEvaluator,
} from "@drawbackengine/drawback-search";
import {
  createPlayerPrivateSearchAgent,
} from "./player-private-agent.js";
import {
  resolvePlayerPrivateRule,
} from "./player-private-catalog.js";
import {
  AUDITED_OPPONENT_PROFILE,
  KING_CAPTURE_DIAGNOSTIC_PROFILE,
  KING_CAPTURE_DIAGNOSTIC_SCENARIOS,
  resolvePlayerPrivateTrainingProfile,
} from "./player-private-scenarios.js";
import {
  simulatePlayerPrivateGame,
  unrestrictedOpponentHypotheses,
} from "./player-private-simulation.js";

const agent = createPlayerPrivateSearchAgent({
  id: "diagnostic-scenario-smoke",
  policyId: "diagnostic-scenario-smoke",
  evaluator: drawbackMaterialEvaluator,
  limits: {
    maxDepth: 1,
    maxNodes: 5_000,
  },
  temperature: {
    temperatureCp: 1,
    topK: 1,
  },
});

describe("player-private diagnostic scenarios", () => {
  it("has symmetric, canonical, public positions and a five-rule profile", () => {
    expect(KING_CAPTURE_DIAGNOSTIC_SCENARIOS).toHaveLength(8);
    expect(KING_CAPTURE_DIAGNOSTIC_PROFILE.ruleIds).toEqual([
      "femme-fatale",
      "nurturer",
      "triple-play",
      "you-best-not-miss",
      "irresistible",
    ]);
    expect(resolvePlayerPrivateTrainingProfile(
      KING_CAPTURE_DIAGNOSTIC_PROFILE.id,
    )).toBe(KING_CAPTURE_DIAGNOSTIC_PROFILE);
    expect(AUDITED_OPPONENT_PROFILE).toMatchObject({
      id: "audited-opponent-v1",
      opponentHypotheses: {
        kind: "audited-uniform",
        version: 1,
      },
    });
    expect(() => {
      resolvePlayerPrivateTrainingProfile("unknown");
    }).toThrow("Unknown");

    const activeColors = new Set<string>();
    for (const scenario of KING_CAPTURE_DIAGNOSTIC_SCENARIOS) {
      const position = CapturableKingPosition.fromFen(scenario.fen);
      expect(position.fen).toBe(scenario.fen);
      activeColors.add(position.turn);
    }
    expect(activeColors).toEqual(new Set(["white", "black"]));
  });

  it(
    "produces promotion-unlock and next-check obligation evidence for both colors",
    async () => {
      for (const color of ["white", "black"] as const) {
        const promotion = scenario(`${color}-promotion-unlock`);
        const nurturer = await simulate(color, "nurturer", promotion.fen);
        const ownPromotionPlies = nurturer.plies.filter(
          (ply) => ply.color === color,
        );
        expect(ownPromotionPlies[0]?.observation.ruleTriggered).toBe(true);
        expect(
          ownPromotionPlies.some(
            (ply) => ply.observation.move.promotion !== undefined,
          ),
        ).toBe(true);
        expect(nurturer.result).toMatchObject({
          kind: "king-capture",
          winner: color,
        });

        const obligation = scenario(`${color}-check-obligation`);
        const bestNotMiss = await simulate(
          color,
          "you-best-not-miss",
          obligation.fen,
        );
        const ownObligationPlies = bestNotMiss.plies.filter(
          (ply) => ply.color === color,
        );
        expect(
          ownObligationPlies.some(
            (ply) =>
              ply.observation.ruleTriggered
              && ply.observation.drawbackLegalMoves.length === 1,
          ),
        ).toBe(true);
        expect(bestNotMiss.result).toMatchObject({
          kind: "king-capture",
          winner: color,
        });
      }
    },
    30_000,
  );
});

function scenario(id: string) {
  const result = KING_CAPTURE_DIAGNOSTIC_SCENARIOS.find(
    (candidate) => candidate.id === id,
  );
  if (result === undefined) {
    throw new Error(`Missing diagnostic scenario ${id}.`);
  }
  return result;
}

async function simulate(
  color: "white" | "black",
  ruleId: "nurturer" | "you-best-not-miss",
  fen: string,
) {
  const target = resolvePlayerPrivateRule(ruleId);
  const control = resolvePlayerPrivateRule("femme-fatale");
  return simulatePlayerPrivateGame({
    seed: 1,
    parameterSeeds: { white: 2, black: 3 },
    rules: {
      white: color === "white" ? target : control,
      black: color === "black" ? target : control,
    },
    whiteAgent: agent,
    blackAgent: agent,
    opponentHypotheses: unrestrictedOpponentHypotheses,
    maxPlies: 4,
    fen,
  });
}
