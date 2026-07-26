import {
  createPrivateSimulationTrace,
  type SimulationResult,
} from "@drawbackengine/simulation-arena";
import { encodePrivateSimulationTraceRecord } from "@drawbackengine/simulation-trace";
import { writeNdjsonFileAtomicNoClobber } from "./atomic-ndjson.js";

export interface TextOutput {
  write(chunk: string): unknown;
}

export interface SimulationTraceOutputOptions {
  readonly gameIndexOffset?: number;
}

export interface WrittenSimulationTraceFile {
  readonly games: number;
  readonly bytes: number;
  readonly sha256: string;
}

function checkedGameIndexOffset(
  games: readonly SimulationResult[],
  options: SimulationTraceOutputOptions,
): number {
  const offset = options.gameIndexOffset ?? 0;
  const lastIndex = Math.max(0, games.length - 1);
  if (
    !Number.isSafeInteger(offset)
    || offset < 0
    || offset > Number.MAX_SAFE_INTEGER - lastIndex
  ) {
    throw new RangeError(
      "gameIndexOffset and game count must remain within safe integers.",
    );
  }
  return offset;
}

/**
 * Writes one complete trusted-engine game trace per line.
 *
 * These traces include the post-game drawback reveal. They are intended for
 * local engine diagnostics, not for a player-facing observation stream.
 */
export function writeSimulationTraceNdjson(
  games: readonly SimulationResult[],
  output: TextOutput,
  options: SimulationTraceOutputOptions = {},
): number {
  const offset = checkedGameIndexOffset(games, options);
  for (const [index, game] of games.entries()) {
    const record = createPrivateSimulationTrace(game, offset + index);
    output.write(encodePrivateSimulationTraceRecord(record));
  }
  return games.length;
}

/**
 * Writes canonical UTF-8 NDJSON to a same-directory temporary file and
 * publishes it without replacing an existing corpus.
 */
export async function writeSimulationTraceNdjsonFileAtomic(
  path: string,
  games: readonly SimulationResult[],
  options: SimulationTraceOutputOptions = {},
): Promise<WrittenSimulationTraceFile> {
  const offset = checkedGameIndexOffset(games, options);
  const chunks = (function* (): Generator<string> {
    for (const [index, game] of games.entries()) {
      yield encodePrivateSimulationTraceRecord(
        createPrivateSimulationTrace(game, offset + index),
      );
    }
  })();
  const written = await writeNdjsonFileAtomicNoClobber(path, chunks);
  return {
    games: written.records,
    bytes: written.bytes,
    sha256: written.sha256,
  };
}
