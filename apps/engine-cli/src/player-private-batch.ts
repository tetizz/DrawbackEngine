import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createPlayerPrivateAssignmentSchedule,
  resolvePlayerPrivateTrainingProfile,
  streamPlayerPrivateAssignmentsParallel,
  type PlayerPrivateDataSplit,
  type PlayerPrivateEvaluatorPolicy,
  type PlayerPrivateOpponentHypothesisPolicy,
  type PlayerPrivateSearchPolicy,
  type PlayerPrivateSplitCounts,
  type ScheduledPlayerPrivateAssignment,
} from "@drawbackengine/simulation-arena";
import {
  writePlayerPrivateSplitTraceFileAtomic,
  type PlayerPrivateTraceWriteProgress,
  type WrittenPlayerPrivateSplitTraceFile,
} from "./player-private-output.js";

export interface PlayerPrivateBatchOptions {
  readonly split: PlayerPrivateDataSplit;
  readonly splitCounts: PlayerPrivateSplitCounts;
  readonly workers: number;
  readonly labelSeed: number;
  readonly gameplaySeed: number;
  readonly parameterSeed: number;
  readonly outputPath: string;
  readonly maxPlies: number;
  readonly windowSize: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly temperatureCp: number;
  readonly profileId: string;
  readonly evaluator: PlayerPrivateEvaluatorPolicy;
  readonly signal?: AbortSignal;
  readonly onProgress?: (
    progress: PlayerPrivateTraceWriteProgress,
  ) => void | Promise<void>;
}

export interface PlayerPrivateBatchResult
  extends WrittenPlayerPrivateSplitTraceFile {
  readonly evaluatorId: string;
  readonly profile: Readonly<{ id: string; policyId: string }>;
  readonly generationConfig: PlayerPrivateBatchGenerationConfig;
}

export interface PlayerPrivateBatchGenerationConfig {
  readonly maxPlies: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly temperatureCp: number;
  readonly topK: number;
  readonly leafCacheEntries: number;
  readonly leafCacheHistoryMode: "full" | "ignore";
  readonly opponentAggregation: "worst-case" | "posterior-expected" | "posterior-cvar-25";
  readonly evaluator: Readonly<
    | {
        readonly kind: "material";
        readonly version: 1;
        readonly evaluatorId: "drawback-material/v1";
      }
    | {
        readonly kind: "node-uci-leaf";
        readonly version: 1;
        readonly evaluatorId: string;
      }
  >;
  readonly opponentHypotheses: PlayerPrivateOpponentHypothesisPolicy;
}

export async function runPlayerPrivateBatch(
  options: PlayerPrivateBatchOptions,
): Promise<PlayerPrivateBatchResult> {
  if (options.splitCounts[options.split] === 0) {
    throw new RangeError(`The selected ${options.split} split has zero games.`);
  }
  const profile = resolvePlayerPrivateTrainingProfile(options.profileId);
  const schedule = selectedSplit(
    createPlayerPrivateAssignmentSchedule({
      splitCounts: options.splitCounts,
      labelSeed: options.labelSeed,
      gameplaySeed: options.gameplaySeed,
      parameterSeed: options.parameterSeed,
      ...(profile.ruleIds === undefined
        ? {}
        : { ruleIds: profile.ruleIds }),
      ...(profile.scenarios === undefined
        ? {}
        : { initialFens: profile.scenarios.map(({ fen }) => fen) }),
    }),
    options.split,
  );
  const policy = playerPrivateSearchPolicy(
    profile.policyId,
    profile.opponentAggregation,
    profile.opponentHypotheses,
    options,
  );
  const games = streamPlayerPrivateAssignmentsParallel({
    assignments: schedule,
    workers: options.workers,
    windowSize: options.windowSize,
    maxPlies: options.maxPlies,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    policy,
  });
  mkdirSync(dirname(options.outputPath), { recursive: true });
  const written = await writePlayerPrivateSplitTraceFileAtomic(
    options.outputPath,
    options.split,
    games,
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined
        ? {}
        : { onProgress: options.onProgress }),
    },
  );
  return Object.freeze({
    ...written,
    evaluatorId: evaluatorId(options.evaluator),
    profile: Object.freeze({ id: profile.id, policyId: profile.policyId }),
    generationConfig: realizedGenerationConfig(
      options.maxPlies,
      policy,
      options.evaluator,
    ),
  });
}

function playerPrivateSearchPolicy(
  profilePolicyId: string,
  opponentAggregation: PlayerPrivateSearchPolicy["opponentAggregation"],
  opponentHypotheses: PlayerPrivateOpponentHypothesisPolicy | undefined,
  options: PlayerPrivateBatchOptions,
): PlayerPrivateSearchPolicy {
  return Object.freeze({
    policyId: evaluatorPolicyId(profilePolicyId, options.evaluator),
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
    temperatureCp: options.temperatureCp,
    topK: 8,
    leafCacheEntries: 16_384,
    leafCacheHistoryMode: "full" as const,
    opponentAggregation: opponentAggregation ?? "worst-case",
    evaluator: options.evaluator,
    opponentHypotheses: Object.freeze({
      ...(opponentHypotheses ?? {
        kind: "unrestricted-baseline" as const,
        version: 1 as const,
      }),
    }),
  });
}

function realizedGenerationConfig(
  maxPlies: number,
  policy: PlayerPrivateSearchPolicy,
  evaluator: PlayerPrivateEvaluatorPolicy,
): PlayerPrivateBatchGenerationConfig {
  if (
    policy.topK === undefined
    || policy.leafCacheEntries === undefined
    || policy.leafCacheHistoryMode === undefined
    || policy.opponentAggregation === undefined
  ) {
    throw new Error("Player-private batch policy was not fully materialized.");
  }
  return Object.freeze({
    maxPlies,
    maxDepth: policy.maxDepth,
    maxNodes: policy.maxNodes,
    temperatureCp: policy.temperatureCp,
    topK: policy.topK,
    leafCacheEntries: policy.leafCacheEntries,
    leafCacheHistoryMode: policy.leafCacheHistoryMode,
    opponentAggregation: policy.opponentAggregation,
    evaluator: evaluator.kind === "material"
      ? Object.freeze({
          kind: "material" as const,
          version: 1 as const,
          evaluatorId: "drawback-material/v1" as const,
        })
      : Object.freeze({
          kind: "node-uci-leaf" as const,
          version: 1 as const,
          evaluatorId: evaluator.evaluatorId,
        }),
    opponentHypotheses: Object.freeze({ ...policy.opponentHypotheses }),
  });
}

function evaluatorPolicyId(
  profilePolicyId: string,
  evaluator: PlayerPrivateEvaluatorPolicy,
): string {
  if (evaluator.kind === "material") {
    return profilePolicyId;
  }
  const profile = profilePolicyId.replace(/^material-/u, "");
  return `node-uci-${evaluator.config.kind}-${profile}`;
}

function evaluatorId(evaluator: PlayerPrivateEvaluatorPolicy): string {
  return evaluator.kind === "material"
    ? "drawback-material/v1"
    : evaluator.evaluatorId;
}

function* selectedSplit(
  schedule: Iterable<ScheduledPlayerPrivateAssignment>,
  split: PlayerPrivateDataSplit,
): Generator<ScheduledPlayerPrivateAssignment> {
  for (const assignment of schedule) {
    if (assignment.split === split) {
      yield assignment;
    }
  }
}
