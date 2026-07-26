import {
  createPlayerPrivateSimulationTrace,
  type PlayerPrivateDataSplit,
  type StreamedPlayerPrivateResult,
} from "@drawbackengine/simulation-arena";
import {
  encodePlayerPrivateSimulationTraceRecord,
} from "@drawbackengine/simulation-trace";
import {
  writeNdjsonFileAtomicNoClobber,
} from "./atomic-ndjson.js";

export interface WrittenPlayerPrivateSplitTraceFile {
  readonly split: PlayerPrivateDataSplit;
  readonly games: number;
  readonly firstGameIndex: number;
  readonly lastGameIndex: number;
  readonly bytes: number;
  readonly sha256: string;
}

export async function writePlayerPrivateSplitTraceFileAtomic(
  path: string,
  split: PlayerPrivateDataSplit,
  games: AsyncIterable<StreamedPlayerPrivateResult>,
): Promise<WrittenPlayerPrivateSplitTraceFile> {
  let firstGameIndex: number | undefined;
  let lastGameIndex: number | undefined;
  let expectedSplitIndex = 0;
  const chunks = (async function* (): AsyncGenerator<string> {
    for await (const game of games) {
      if (game.split !== split) {
        throw new TypeError(
          `Expected only ${split} games but received ${game.split}.`,
        );
      }
      if (game.splitIndex !== expectedSplitIndex) {
        throw new RangeError(
          `${split} split indexes must begin at zero and remain contiguous.`,
        );
      }
      if (
        lastGameIndex !== undefined
        && game.globalIndex !== lastGameIndex + 1
      ) {
        throw new RangeError(
          `${split} global game indexes must remain contiguous.`,
        );
      }
      firstGameIndex ??= game.globalIndex;
      lastGameIndex = game.globalIndex;
      expectedSplitIndex += 1;
      try {
        yield encodePlayerPrivateSimulationTraceRecord(
          createPlayerPrivateSimulationTrace(
            game.result,
            game.globalIndex,
          ),
        );
      } catch (error: unknown) {
        const detail =
          error instanceof Error ? error.message : "Unknown trace error.";
        throw new Error(
          `Failed to encode ${split} game ${String(game.splitIndex)} `
            + `(global index ${String(game.globalIndex)}, seed `
            + `${String(game.assignment.seed)}, `
            + `${game.assignment.whiteRuleId} versus `
            + `${game.assignment.blackRuleId}): ${detail}`,
          { cause: error },
        );
      }
    }
    if (expectedSplitIndex === 0) {
      throw new RangeError(`Cannot publish an empty ${split} split.`);
    }
  })();
  const written = await writeNdjsonFileAtomicNoClobber(path, chunks);
  if (firstGameIndex === undefined || lastGameIndex === undefined) {
    throw new Error("Published split lost its game index bounds.");
  }
  return {
    split,
    games: written.records,
    firstGameIndex,
    lastGameIndex,
    bytes: written.bytes,
    sha256: written.sha256,
  };
}
