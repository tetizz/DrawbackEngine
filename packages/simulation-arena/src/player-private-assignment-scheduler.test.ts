import { describe, expect, it } from "vitest";
import {
  createPlayerPrivateAssignmentSchedule,
  type ScheduledPlayerPrivateAssignment,
} from "./player-private-assignment-scheduler.js";
import {
  PLAYER_PRIVATE_RULE_IDS,
} from "./player-private-catalog.js";

const roots = {
  labelSeed: 11,
  gameplaySeed: 22,
  parameterSeed: 33,
} as const;

describe("player-private assignment scheduler", () => {
  it("balances marginals and every ordered pair independently per split", () => {
    const ruleCount = PLAYER_PRIVATE_RULE_IDS.length;
    const pairCycle = ruleCount * ruleCount;
    const schedule = [...createPlayerPrivateAssignmentSchedule({
      ...roots,
      splitCounts: {
        train: pairCycle,
        validation: pairCycle,
        test: pairCycle,
      },
    })];

    expect(schedule).toHaveLength(pairCycle * 3);
    for (const split of ["train", "validation", "test"] as const) {
      const games = schedule.filter((game) => game.split === split);
      const whiteCounts = counts(
        games.map((game) => game.assignment.whiteRuleId),
      );
      const blackCounts = counts(
        games.map((game) => game.assignment.blackRuleId),
      );
      const pairCounts = counts(games.map((game) =>
        `${game.assignment.whiteRuleId}/${game.assignment.blackRuleId}`));
      expect(new Set(whiteCounts.values())).toEqual(new Set([ruleCount]));
      expect(new Set(blackCounts.values())).toEqual(new Set([ruleCount]));
      expect(pairCounts.size).toBe(pairCycle);
      expect(new Set(pairCounts.values())).toEqual(new Set([1]));
      expect(games.map((game) => game.splitIndex)).toEqual(
        Array.from({ length: pairCycle }, (_, index) => index),
      );
    }
  });

  it("keeps all gameplay seeds unique across contiguous held-out splits", () => {
    const schedule = [...createPlayerPrivateAssignmentSchedule({
      ...roots,
      splitCounts: { train: 137, validation: 31, test: 29 },
    })];
    const seeds = schedule.map((game) => game.assignment.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
    for (const color of ["white", "black"] as const) {
      const parameterSeeds = schedule.map(
        (game) => game.assignment.parameterSeeds[color],
      );
      expect(new Set(parameterSeeds).size).toBe(parameterSeeds.length);
    }
    expect(schedule.map((game) => game.globalIndex)).toEqual(
      Array.from({ length: schedule.length }, (_, index) => index),
    );
    expect(schedule[136]?.split).toBe("train");
    expect(schedule[137]?.split).toBe("validation");
    expect(schedule[168]?.split).toBe("test");

    for (const split of ["train", "validation", "test"] as const) {
      const games = schedule.filter((game) => game.split === split);
      expectSpreadAtMostOne(games.map(
        (game) => game.assignment.whiteRuleId,
      ), PLAYER_PRIVATE_RULE_IDS);
      expectSpreadAtMostOne(games.map(
        (game) => game.assignment.blackRuleId,
      ), PLAYER_PRIVATE_RULE_IDS);
      const allPairs = PLAYER_PRIVATE_RULE_IDS.flatMap((white) =>
        PLAYER_PRIVATE_RULE_IDS.map((black) => `${white}/${black}`));
      expectSpreadAtMostOne(games.map(rulePair), allPairs);
    }
  });

  it("separates label, gameplay, and hidden-parameter randomness", () => {
    const splitCounts = { train: 23, validation: 7, test: 5 };
    const baseline = [...createPlayerPrivateAssignmentSchedule({
      ...roots,
      splitCounts,
    })];
    const differentLabels = [...createPlayerPrivateAssignmentSchedule({
      ...roots,
      labelSeed: 12,
      splitCounts,
    })];
    const differentGameplay = [...createPlayerPrivateAssignmentSchedule({
      ...roots,
      gameplaySeed: 23,
      splitCounts,
    })];
    const differentParameters = [...createPlayerPrivateAssignmentSchedule({
      ...roots,
      parameterSeed: 34,
      splitCounts,
    })];

    expect(differentLabels.map(publicSeeds)).toEqual(
      baseline.map(publicSeeds),
    );
    expect(differentLabels.map(rulePair)).not.toEqual(
      baseline.map(rulePair),
    );
    expect(differentGameplay.map(rulePair)).toEqual(
      baseline.map(rulePair),
    );
    expect(differentGameplay.map(parameterSeeds)).toEqual(
      baseline.map(parameterSeeds),
    );
    expect(differentGameplay.map((game) => game.assignment.seed)).not.toEqual(
      baseline.map((game) => game.assignment.seed),
    );
    expect(differentParameters.map(rulePair)).toEqual(
      baseline.map(rulePair),
    );
    expect(differentParameters.map((game) => game.assignment.seed)).toEqual(
      baseline.map((game) => game.assignment.seed),
    );
    expect(differentParameters.map(parameterSeeds)).not.toEqual(
      baseline.map(parameterSeeds),
    );
  });

  it("snapshots caller-owned rule lists and rejects invalid domains", () => {
    const mutableRules = [...PLAYER_PRIVATE_RULE_IDS];
    const iterable = createPlayerPrivateAssignmentSchedule({
      ...roots,
      splitCounts: { train: 4, validation: 0, test: 0 },
      ruleIds: mutableRules,
    });
    mutableRules.reverse();
    const afterMutation = [...iterable];
    const pristine = [...createPlayerPrivateAssignmentSchedule({
      ...roots,
      splitCounts: { train: 4, validation: 0, test: 0 },
    })];
    expect(afterMutation).toEqual(pristine);

    expect(() => createPlayerPrivateAssignmentSchedule({
      ...roots,
      splitCounts: { train: 0, validation: 0, test: 0 },
    })).toThrow("from 1");
    expect(() => createPlayerPrivateAssignmentSchedule({
      ...roots,
      splitCounts: { train: -1, validation: 1, test: 0 },
    })).toThrow("non-negative");
    expect(() => createPlayerPrivateAssignmentSchedule({
      ...roots,
      splitCounts: { train: 1, validation: 0, test: 0 },
      ruleIds: ["vegan", "vegan"],
    })).toThrow("unique subset");
  });
});

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return result;
}

function expectSpreadAtMostOne(
  values: readonly string[],
  domain: readonly string[],
): void {
  const observed = counts(values);
  const frequencies = domain.map((value) => observed.get(value) ?? 0);
  expect(Math.max(...frequencies) - Math.min(...frequencies)).toBeLessThanOrEqual(
    1,
  );
}

function rulePair(
  game: ScheduledPlayerPrivateAssignment,
): string {
  return `${game.assignment.whiteRuleId}/${game.assignment.blackRuleId}`;
}

function parameterSeeds(
  game: ScheduledPlayerPrivateAssignment,
): string {
  return `${String(game.assignment.parameterSeeds.white)}/${String(
    game.assignment.parameterSeeds.black,
  )}`;
}

function publicSeeds(
  game: ScheduledPlayerPrivateAssignment,
): string {
  return `${String(game.assignment.seed)}/${parameterSeeds(game)}`;
}
