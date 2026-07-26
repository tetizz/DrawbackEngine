import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { link, rm } from "node:fs/promises";
import { finished } from "node:stream/promises";

export interface WrittenNdjsonFile {
  readonly records: number;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Writes one canonical record chunk at a time with bounded stream backpressure
 * and publishes through a same-directory no-clobber hard link.
 */
export async function writeNdjsonFileAtomicNoClobber(
  path: string,
  chunks: Iterable<string> | AsyncIterable<string>,
): Promise<WrittenNdjsonFile> {
  const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  const stream = createWriteStream(temporaryPath, {
    encoding: "utf8",
    flags: "wx",
    mode: 0o600,
  });
  const hash = createHash("sha256");
  let records = 0;
  let bytes = 0;
  try {
    for await (const chunk of chunks) {
      assertSingleNdjsonRecord(chunk);
      hash.update(chunk, "utf8");
      bytes += Buffer.byteLength(chunk, "utf8");
      records += 1;
      if (!stream.write(chunk, "utf8")) {
        await once(stream, "drain");
      }
    }
    stream.end();
    await finished(stream);
    await publishNoClobber(temporaryPath, path);
    return {
      records,
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
        "NDJSON generation failed and its private temporary file could not be removed.",
      );
    }
    throw error;
  }
}

function assertSingleNdjsonRecord(chunk: string): void {
  if (
    chunk.length < 2
    || !chunk.endsWith("\n")
    || chunk.slice(0, -1).includes("\n")
  ) {
    throw new TypeError(
      "Each NDJSON chunk must contain exactly one newline-terminated record.",
    );
  }
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
        "Published NDJSON cleanup failed for both temporary and final paths.",
      );
    }
    throw error;
  }
}
