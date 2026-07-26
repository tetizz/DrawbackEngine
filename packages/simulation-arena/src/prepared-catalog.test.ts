import { describe, expect, it } from "vitest";
import type {
  ExternalTurnConstraint,
  ExternalTurnConstraintProvider,
  ExternalTurnConstraintRequest,
} from "@drawbackengine/drawback-engine";
import {
  CATALOG_AGENT_IDS,
  deriveCatalogGameSpec,
  type ExecutableRuleId,
} from "./catalog.js";
import {
  PREPARED_EXECUTABLE_RULE_IDS,
  derivePreparedCatalogGameSpec,
  resolvePreparedCatalogRule,
  simulatePreparedCatalogAssignedGame,
  simulatePreparedCatalogGame,
} from "./prepared-catalog.js";

class FirstRootProvider implements ExternalTurnConstraintProvider {
  public readonly requests: ExternalTurnConstraintRequest[] = [];

  public resolve(
    request: ExternalTurnConstraintRequest,
  ): Promise<ExternalTurnConstraint> {
    this.requests.push(request);
    const bestMoveUci = request.ordinaryRootMoves[0];
    if (bestMoveUci === undefined) {
      throw new Error("Expected at least one evaluator root move.");
    }
    return Promise.resolve({
      provider: request.provider,
      policyId: request.policyId,
      positionKey: request.positionKey,
      bestMoveUci,
      requestDigest: "ab".repeat(32),
      engineFingerprint: "prepared-catalog-test",
    });
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("prepared asynchronous simulation catalog", () => {
  it("exposes every one of the 182 prepared executable rules", () => {
    expect(PREPARED_EXECUTABLE_RULE_IDS).toHaveLength(182);
    expect(new Set(PREPARED_EXECUTABLE_RULE_IDS)).toHaveLength(182);
    expect(PREPARED_EXECUTABLE_RULE_IDS).toEqual(
      expect.arrayContaining(["hand-and-gigabrain", "ichtyophobe"]),
    );
    for (const id of PREPARED_EXECUTABLE_RULE_IDS) {
      expect(resolvePreparedCatalogRule(id).id).toBe(id);
    }
  });

  it("preserves synchronous catalog selection semantics for the same choices", () => {
    const ruleIds: readonly ExecutableRuleId[] = [
      "vegan",
      "checkers",
      "spice-of-life",
    ];
    const agentIds = [
      CATALOG_AGENT_IDS[0],
      CATALOG_AGENT_IDS[2],
      CATALOG_AGENT_IDS[4],
    ] as const;

    for (const seed of [0, 1, 17, 0xffff_ffff]) {
      expect(
        derivePreparedCatalogGameSpec(seed, { ruleIds, agentIds }),
      ).toEqual(deriveCatalogGameSpec(seed, { ruleIds, agentIds }));
    }
  });

  it("derives evaluator-backed specs deterministically", () => {
    const options = {
      ruleIds: ["hand-and-gigabrain", "ichtyophobe"],
      agentIds: ["random-legal", "human-like-medium"],
    } as const;
    const first = derivePreparedCatalogGameSpec(0x51ec7, options);
    expect(derivePreparedCatalogGameSpec(0x51ec7, options)).toEqual(first);
    expect(options.ruleIds).toContain(first.whiteRuleId);
    expect(options.ruleIds).toContain(first.blackRuleId);
    expect(first.whiteAgent.strength).toBeGreaterThan(0);
    expect(first.blackAgent.strength).toBeGreaterThan(0);
  });

  it("simulates evaluator-backed games with the caller's borrowed provider", async () => {
    const provider = new FirstRootProvider();
    const game = await simulatePreparedCatalogGame(91, provider, {
      ruleIds: ["hand-and-gigabrain"],
      agentIds: ["random-legal"],
      maxPlies: 2,
    });

    expect(game.drawbacks).toEqual({
      white: "hand-and-gigabrain",
      black: "hand-and-gigabrain",
    });
    expect(game.plies).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    expect(
      game.plies.every(
        (ply) => ply.observation.externalConstraint !== undefined,
      ),
    ).toBe(true);
  });

  it("preserves explicit scheduler labels and agents", async () => {
    const provider = new FirstRootProvider();
    const game = await simulatePreparedCatalogAssignedGame(
      {
        seed: 91,
        whiteRuleId: "hand-and-gigabrain",
        blackRuleId: "vegan",
        whiteAgentId: "random-legal",
        blackAgentId: "greedy-material",
      },
      provider,
      { maxPlies: 2 },
    );

    expect(game.drawbacks).toEqual({
      white: "hand-and-gigabrain",
      black: "vegan",
    });
    expect(game.agents.white.id).toBe("random-legal");
    expect(game.agents.black.id).toBe("greedy-material");
    expect(game.plies).toHaveLength(2);
  });

  it("rejects empty selection catalogs", () => {
    expect(() =>
      derivePreparedCatalogGameSpec(1, { ruleIds: [] }),
    ).toThrow(RangeError);
    expect(() =>
      derivePreparedCatalogGameSpec(1, { agentIds: [] }),
    ).toThrow(RangeError);
  });
});
