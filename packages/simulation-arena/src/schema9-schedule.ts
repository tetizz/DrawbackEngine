import {
  PLAYER_PRIVATE_RULE_IDS,
} from "./player-private-catalog.js";
import {
  STANDARD_PLAYER_PRIVATE_PROFILE,
} from "./player-private-scenarios.js";

export const SCHEMA9_SCHEDULE_AUTHORITY_ID =
  "capturable25-schema9-opportunity/v1" as const;
export const SCHEMA9_GENERATOR_LAUNCH_FORMAT =
  "drawbackengine-player-private-schedule-launch" as const;
export const SCHEMA9_GENERATOR_COMPLETION_FORMAT =
  "drawbackengine-player-private-schedule-completion" as const;
export const SCHEMA9_GENERATOR_RECEIPT_VERSION = 3 as const;
export const SCHEMA9_PRODUCER_RUNTIME_FORMAT =
  "drawbackengine-schema9-producer-runtime" as const;
export const SCHEMA9_PRODUCER_RUNTIME_VERSION = 1 as const;
export const SCHEMA9_PRODUCER_RUNTIME_ALGORITHM =
  "sha256-engine-runtime-tree-v1" as const;
export const SCHEMA9_COORDINATOR_COMPONENT_ID =
  "schema9-coordinator/v1" as const;
export const SCHEMA9_PARALLEL_WORKER_COMPONENT_ID =
  "player-private-parallel-worker/v1" as const;
export const SCHEMA9_LEDGER_SPLITS = Object.freeze([
  "train",
  "validation-a",
  "validation-b",
  "test",
] as const);
export type Schema9LedgerSplit = (typeof SCHEMA9_LEDGER_SPLITS)[number];
export type Schema9SeedRoots = readonly [number, number, number];

export interface Schema9RuntimeDescriptor {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly execArgv: readonly [];
}

export interface Schema9RuntimeComponentIdentity {
  readonly componentId:
    | typeof SCHEMA9_COORDINATOR_COMPONENT_ID
    | typeof SCHEMA9_PARALLEL_WORKER_COMPONENT_ID;
  readonly files: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface Schema9ProducerRuntimeIdentity {
  readonly format: typeof SCHEMA9_PRODUCER_RUNTIME_FORMAT;
  readonly version: typeof SCHEMA9_PRODUCER_RUNTIME_VERSION;
  readonly algorithm: typeof SCHEMA9_PRODUCER_RUNTIME_ALGORITHM;
  readonly runtime: Schema9RuntimeDescriptor;
  readonly coordinator: Schema9RuntimeComponentIdentity & Readonly<{
    componentId: typeof SCHEMA9_COORDINATOR_COMPONENT_ID;
  }>;
  readonly parallelWorker: Schema9RuntimeComponentIdentity & Readonly<{
    componentId: typeof SCHEMA9_PARALLEL_WORKER_COMPONENT_ID;
  }>;
  readonly aggregateSha256: string;
}

export const SCHEMA9_SPLIT_SEED_ROOTS = Object.freeze({
  train: Object.freeze([
    1_261_462_769,
    242_269_024,
    1_837_697_911,
  ] as const),
  "validation-a": Object.freeze([
    2_069_246_597,
    1_391_196_133,
    2_739_675_947,
  ] as const),
  "validation-b": Object.freeze([
    3_786_384_219,
    3_547_865_132,
    2_689_552_677,
  ] as const),
  test: Object.freeze([
    2_033_321_041,
    1_354_035_545,
    4_189_758_462,
  ] as const),
} satisfies Readonly<Record<Schema9LedgerSplit, Schema9SeedRoots>>);

export const SCHEMA9_SCHEDULE_PROFILE = Object.freeze({
  id: STANDARD_PLAYER_PRIVATE_PROFILE.id,
  policyId: STANDARD_PLAYER_PRIVATE_PROFILE.policyId,
} as const);
export const SCHEMA9_GENERATOR_CONFIG = Object.freeze({
  maxPlies: 120,
  maxDepth: 2,
  maxNodes: 50_000,
  temperatureCp: 35,
  topK: 8,
  leafCacheEntries: 16_384,
  leafCacheHistoryMode: "full" as const,
  opponentAggregation: "worst-case" as const,
  evaluator: Object.freeze({
    kind: "material" as const,
    version: 1 as const,
    evaluatorId: "drawback-material/v1" as const,
  }),
  opponentHypotheses: Object.freeze({
    kind: "unrestricted-baseline" as const,
    version: 1 as const,
  }),
} as const);

export interface Schema9EngineSchedule {
  readonly ledgerSplit: Schema9LedgerSplit;
  readonly games: number;
  readonly engineSplit: "train";
  readonly splitCounts: Readonly<{
    train: number;
    validation: 0;
    test: 0;
  }>;
  readonly seedRoots: Schema9SeedRoots;
  readonly scheduleProfile: typeof SCHEMA9_SCHEDULE_PROFILE;
}

export function schema9EngineSchedule(
  ledgerSplit: Schema9LedgerSplit,
  games: number,
): Schema9EngineSchedule {
  if (!SCHEMA9_LEDGER_SPLITS.includes(ledgerSplit)) {
    throw new RangeError("Unknown schema-9 ledger split.");
  }
  if (
    !Number.isSafeInteger(games)
    || games <= 0
    || games > 0xffff_ffff
    || games % PLAYER_PRIVATE_RULE_IDS.length !== 0
  ) {
    throw new RangeError(
      `Schema-9 games must be a positive 32-bit multiple of ${String(
        PLAYER_PRIVATE_RULE_IDS.length,
      )}.`,
    );
  }
  return Object.freeze({
    ledgerSplit,
    games,
    engineSplit: "train" as const,
    splitCounts: Object.freeze({
      train: games,
      validation: 0 as const,
      test: 0 as const,
    }),
    seedRoots: SCHEMA9_SPLIT_SEED_ROOTS[ledgerSplit],
    scheduleProfile: SCHEMA9_SCHEDULE_PROFILE,
  });
}
