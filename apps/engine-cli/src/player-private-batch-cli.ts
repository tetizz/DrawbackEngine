import { availableParallelism } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createPlayerPrivateAssignmentSchedule,
  PLAYER_PRIVATE_DATA_SPLITS,
  resolvePlayerPrivateTrainingProfile,
  streamPlayerPrivateAssignmentsParallel,
  type PlayerPrivateDataSplit,
  type ScheduledPlayerPrivateAssignment,
} from "@drawbackengine/simulation-arena";
import {
  writePlayerPrivateSplitTraceFileAtomic,
} from "./player-private-output.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const split = dataSplit(args[0] ?? "train");
  const splitCounts = {
    train: nonNegativeInteger(args[1], 100),
    validation: nonNegativeInteger(args[2], 20),
    test: nonNegativeInteger(args[3], 20),
  };
  if (splitCounts[split] === 0) {
    throw new RangeError(`The selected ${split} split has zero games.`);
  }
  const workers = positiveInteger(
    args[4],
    Math.max(1, availableParallelism() - 1),
  );
  const labelSeed = unsignedSeed(args[5], 0x1abe_1001);
  const gameplaySeed = unsignedSeed(args[6], 0x6a6d_2002);
  const parameterSeed = unsignedSeed(args[7], 0x9a2a_3003);
  const invocationDirectory = process.env["INIT_CWD"] ?? process.cwd();
  const outputPath = resolve(
    invocationDirectory,
    args[8] ?? `data/player-private-${split}.ndjson`,
  );
  const maxPlies = positiveInteger(args[9], 120);
  const windowSize = positiveInteger(args[10], workers * 4);
  const maxDepth = positiveInteger(args[11], 2);
  const maxNodes = positiveInteger(args[12], 50_000);
  const temperatureCp = positiveNumber(args[13], 35);
  const profile = resolvePlayerPrivateTrainingProfile(
    args[14] ?? "standard",
  );
  const schedule = selectedSplit(
    createPlayerPrivateAssignmentSchedule({
      splitCounts,
      labelSeed,
      gameplaySeed,
      parameterSeed,
      ...(profile.ruleIds === undefined
        ? {}
        : { ruleIds: profile.ruleIds }),
      ...(profile.scenarios === undefined
        ? {}
        : {
            initialFens: profile.scenarios.map(({ fen }) => fen),
          }),
    }),
    split,
  );
  const games = streamPlayerPrivateAssignmentsParallel({
    assignments: schedule,
    workers,
    windowSize,
    maxPlies,
    policy: {
      policyId: profile.policyId,
      maxDepth,
      maxNodes,
      temperatureCp,
      topK: 8,
      leafCacheEntries: 16_384,
      leafCacheHistoryMode: "full",
      opponentAggregation:
        profile.opponentAggregation ?? "worst-case",
      evaluator: { kind: "material", version: 1 },
      opponentHypotheses: {
        ...(profile.opponentHypotheses ?? {
          kind: "unrestricted-baseline",
          version: 1,
        }),
      },
    },
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  const written = await writePlayerPrivateSplitTraceFileAtomic(
    outputPath,
    split,
    games,
  );
  console.log(
    `Wrote ${String(written.games)} ${split} player-private traces `
      + `(${String(written.bytes)} bytes, sha256 ${written.sha256}) `
      + `for global indexes ${String(written.firstGameIndex)}-`
      + `${String(written.lastGameIndex)} to ${outputPath}`,
  );
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

function dataSplit(value: string): PlayerPrivateDataSplit {
  if (
    !PLAYER_PRIVATE_DATA_SPLITS.includes(
      value as PlayerPrivateDataSplit,
    )
  ) {
    throw new RangeError("Split must be train, validation, or test.");
  }
  return value as PlayerPrivateDataSplit;
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError("Split counts must be non-negative integers.");
  }
  return parsed;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError("Expected a positive safe integer.");
  }
  return parsed;
}

function positiveNumber(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError("Expected a finite positive number.");
  }
  return parsed;
}

function unsignedSeed(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 0
    || parsed > 0xffff_ffff
  ) {
    throw new RangeError("Seeds must be unsigned 32-bit integers.");
  }
  return parsed;
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown player-private error.";
  console.error(`Player-private batch failed: ${message}`);
  process.exitCode = 1;
});
