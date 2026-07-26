import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { link, rm } from "node:fs/promises";
import { finished } from "node:stream/promises";
import {
  createPrivateSimulationTrace,
  type SimulationResult,
} from "@drawbackengine/simulation-arena";
import { encodePrivateSimulationTraceRecord } from "@drawbackengine/simulation-trace";

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

async function removeIfPresent(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

async function publishNoClobber(
  temporaryPath: string,
  path: string,
): Promise<void> {
  await link(temporaryPath, path);
  try {
    await rm(temporaryPath);
  } catch (error: unknown) {
    try {
      await removeIfPresent(path);
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "Published trace cleanup failed for both temporary and final paths.",
      );
    }
    throw error;
  }
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
  const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  const stream = createWriteStream(temporaryPath, {
    encoding: "utf8",
    flags: "wx",
    mode: 0o600,
  });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (const [index, game] of games.entries()) {
      const chunk = encodePrivateSimulationTraceRecord(
        createPrivateSimulationTrace(game, offset + index),
      );
      hash.update(chunk, "utf8");
      bytes += Buffer.byteLength(chunk, "utf8");
      if (!stream.write(chunk, "utf8")) {
        await once(stream, "drain");
      }
    }
    stream.end();
    await finished(stream);
    await publishNoClobber(temporaryPath, path);
    return {
      games: games.length,
      bytes,
      sha256: hash.digest("hex"),
    };
  } catch (error: unknown) {
    stream.destroy();
    await finished(stream).catch(() => undefined);
    try {
      await removeIfPresent(temporaryPath);
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "Trace generation failed and its private temporary file could not be removed.",
      );
    }
    throw error;
  }
}
