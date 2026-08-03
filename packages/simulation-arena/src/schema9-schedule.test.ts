import { describe, expect, it } from "vitest";
import {
  schema9EngineSchedule,
  SCHEMA9_GENERATOR_CONFIG,
  SCHEMA9_LEDGER_SPLITS,
  SCHEMA9_SCHEDULE_PROFILE,
  SCHEMA9_SPLIT_SEED_ROOTS,
} from "./schema9-schedule.js";

describe("schema-9 Engine schedule", () => {
  it.each(SCHEMA9_LEDGER_SPLITS)(
    "pins an isolated balanced Engine schedule for %s",
    (split) => {
      expect(schema9EngineSchedule(split, 625)).toEqual({
        ledgerSplit: split,
        games: 625,
        engineSplit: "train",
        splitCounts: { train: 625, validation: 0, test: 0 },
        seedRoots: SCHEMA9_SPLIT_SEED_ROOTS[split],
        scheduleProfile: SCHEMA9_SCHEDULE_PROFILE,
      });
    },
  );

  it("requires complete 25-label cycles", () => {
    expect(() => schema9EngineSchedule("train", 0)).toThrow(
      "positive 32-bit multiple of 25",
    );
    expect(() => schema9EngineSchedule("train", 24)).toThrow(
      "positive 32-bit multiple of 25",
    );
    expect(() => schema9EngineSchedule("train", 4_294_967_300)).toThrow(
      "positive 32-bit multiple of 25",
    );
    expect(schema9EngineSchedule("train", 25).games).toBe(25);
  });

  it("pins every corpus-semantic generation setting", () => {
    expect(SCHEMA9_GENERATOR_CONFIG).toEqual({
      maxPlies: 120,
      maxDepth: 2,
      maxNodes: 50_000,
      temperatureCp: 35,
      topK: 8,
      leafCacheEntries: 16_384,
      leafCacheHistoryMode: "full",
      opponentAggregation: "worst-case",
      evaluator: {
        kind: "material",
        version: 1,
        evaluatorId: "drawback-material/v1",
      },
      opponentHypotheses: {
        kind: "unrestricted-baseline",
        version: 1,
      },
    });
  });
});
