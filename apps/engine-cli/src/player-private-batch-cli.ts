import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import {
  PLAYER_PRIVATE_DATA_SPLITS,
  type PlayerPrivateDataSplit,
  type PlayerPrivateEvaluatorPolicy,
} from "@drawbackengine/simulation-arena";
import { runPlayerPrivateBatch } from "./player-private-batch.js";
import {
  loadPlayerPrivateEvaluatorPolicy,
} from "./player-private-evaluator-config.js";
import { formatPublicFailureMessage } from "./failure-redaction.js";
import { retryRetainedCleanup } from "./retained-cleanup.js";
import {
  findCleanupTerminationError,
  installTerminationSignal,
} from "./termination-signal.js";

const termination = installTerminationSignal();

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
  const profileId = args[14] ?? "standard";
  const evaluator = await evaluatorPolicy(
    args[15] ?? "material",
    args[16],
    invocationDirectory,
  );
  const written = await runPlayerPrivateBatch({
    split,
    splitCounts,
    workers,
    labelSeed,
    gameplaySeed,
    parameterSeed,
    outputPath,
    maxPlies,
    windowSize,
    maxDepth,
    maxNodes,
    temperatureCp,
    profileId,
    evaluator,
    signal: termination.signal,
    onProgress: ({ games: recordsWritten, bytes: bytesWritten }) => {
      console.log(JSON.stringify({
        kind: "player-private-progress",
        recordsWritten,
        totalGames: splitCounts[split],
        bytesWritten,
      }));
    },
  });
  console.log(JSON.stringify({
    kind: "player-private-complete",
    split,
    games: written.games,
    bytes: written.bytes,
    sha256: written.sha256,
    firstGameIndex: written.firstGameIndex,
    lastGameIndex: written.lastGameIndex,
    evaluatorId: written.evaluatorId,
  }));
}

async function evaluatorPolicy(
  mode: string,
  configPath: string | undefined,
  invocationDirectory: string,
): Promise<PlayerPrivateEvaluatorPolicy> {
  if (mode === "material") {
    if (configPath !== undefined) {
      throw new RangeError(
        "Material evaluator mode does not accept a configuration file.",
      );
    }
    return { kind: "material", version: 1 };
  }
  if (mode !== "node-uci-leaf") {
    throw new RangeError(
      "Evaluator mode must be material or node-uci-leaf.",
    );
  }
  if (configPath === undefined) {
    throw new RangeError(
      "node-uci-leaf mode requires a private evaluator configuration.",
    );
  }
  return loadPlayerPrivateEvaluatorPolicy(
    resolve(invocationDirectory, configPath),
  );
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

void main().catch(async (error: unknown) => {
  const reported = await retryRetainedPoolCleanup(error);
  const message = formatPublicFailureMessage(
    reported,
    "Unknown player-private error.",
  );
  console.error(JSON.stringify({
    kind: "player-private-failure",
    message,
  }));
  process.exitCode = findCleanupTerminationError(reported)?.exitCode ?? 1;
}).finally(() => {
  termination.dispose();
});

async function retryRetainedPoolCleanup(error: unknown): Promise<unknown> {
  return retryRetainedCleanup(error, 2);
}
