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

export interface NdjsonWriteProgress {
  readonly records: number;
  readonly bytes: number;
}

export interface NdjsonWriteOptions {
  readonly onProgress?: (
    progress: NdjsonWriteProgress,
  ) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

/** Sensitive output files remain owned and retryable without exposing paths. */
export class RetainedFileCleanupError extends AggregateError {
  public readonly cleanupComplete = false;
  readonly #targets: readonly string[];
  readonly #failures: readonly unknown[];
  readonly #cleanupOwnerIdentity: object;
  #activeRetry: Promise<void> | undefined;

  public constructor(
    failures: readonly unknown[],
    targets: readonly string[],
    cleanupOwnerIdentity: object = Object.freeze({}),
  ) {
    super(
      failures,
      "Private NDJSON file cleanup remains incomplete.",
    );
    this.name = "RetainedFileCleanupError";
    this.#failures = [...failures];
    this.#targets = [...targets];
    this.#cleanupOwnerIdentity = cleanupOwnerIdentity;
  }

  public cleanupOwnerIdentity(): object {
    return this.#cleanupOwnerIdentity;
  }

  public retryCleanup(): Promise<void> {
    if (this.#activeRetry !== undefined) {
      return this.#activeRetry;
    }
    const attempt = removePrivateFiles(this.#targets).then((outcome) => {
      if (outcome.remaining.length > 0) {
        throw new RetainedFileCleanupError(
          [...this.#failures, ...outcome.failures],
          outcome.remaining,
          this.#cleanupOwnerIdentity,
        );
      }
    });
    this.#activeRetry = attempt;
    void attempt.finally(() => {
      if (this.#activeRetry === attempt) {
        this.#activeRetry = undefined;
      }
    }).catch(() => undefined);
    return attempt;
  }
}

/**
 * Writes one canonical record chunk at a time with bounded stream backpressure
 * and publishes through a same-directory no-clobber hard link.
 */
export async function writeNdjsonFileAtomicNoClobber(
  path: string,
  chunks: Iterable<string> | AsyncIterable<string>,
  options: NdjsonWriteOptions = {},
): Promise<WrittenNdjsonFile> {
  throwIfAborted(options.signal);
  const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  const stream = createWriteStream(temporaryPath, {
    encoding: "utf8",
    flags: "wx",
    mode: 0o600,
  });
  const openState = { opened: false };
  stream.once("open", () => {
    openState.opened = true;
  });
  const completion = finished(stream);
  let streamFailure: unknown;
  // Observe open/write failures immediately. The same promise is awaited below
  // so the original error still reaches the caller without becoming unhandled.
  void completion.catch((error: unknown) => {
    streamFailure = error;
  });
  const hash = createHash("sha256");
  let records = 0;
  let bytes = 0;
  let finalLinkCreated = false;
  const onAbort = (): void => {
    stream.destroy(abortFailure(options.signal));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of chunks) {
      throwIfAborted(options.signal);
      assertSingleNdjsonRecord(chunk);
      hash.update(chunk, "utf8");
      bytes += Buffer.byteLength(chunk, "utf8");
      records += 1;
      if (!stream.write(chunk, "utf8")) {
        await Promise.race([once(stream, "drain"), completion]);
      }
      await options.onProgress?.(Object.freeze({ records, bytes }));
      throwIfAborted(options.signal);
    }
    throwIfAborted(options.signal);
    stream.end();
    await completion;
    throwIfAborted(options.signal);
    await link(temporaryPath, path);
    finalLinkCreated = true;
    throwIfAborted(options.signal);
    await rm(temporaryPath);
    throwIfAborted(options.signal);
    return {
      records,
      bytes,
      sha256: hash.digest("hex"),
    };
  } catch (error: unknown) {
    stream.destroy();
    await completion.catch((completionError: unknown) => {
      streamFailure ??= completionError;
    });
    if (!openState.opened && isNodeError(streamFailure, "ENAMETOOLONG")) {
      // The filesystem rejected the initial open before this process ever
      // owned a file. Preserve that actionable failure without claiming that
      // an impossible temporary path still contains private bytes.
      throw error;
    }
    return await throwAfterPrivateFileCleanup(
      error,
      finalLinkCreated
        ? [temporaryPath, path]
        : [temporaryPath],
    );
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortFailure(signal);
  }
}

function abortFailure(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Private NDJSON generation was interrupted.");
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

async function throwAfterPrivateFileCleanup(
  originalFailure: unknown,
  targets: readonly string[],
): Promise<never> {
  let remaining = [...new Set(targets)];
  const cleanupFailures: unknown[] = [];
  for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt += 1) {
    const outcome = await removePrivateFiles(remaining);
    cleanupFailures.push(...outcome.failures);
    remaining = [...outcome.remaining];
  }
  if (remaining.length > 0) {
    throw new RetainedFileCleanupError(
      [originalFailure, ...cleanupFailures],
      remaining,
    );
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [originalFailure, ...cleanupFailures],
      "NDJSON generation failed after private file cleanup recovered.",
    );
  }
  throw originalFailure;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

async function removePrivateFiles(
  targets: readonly string[],
): Promise<{
  readonly remaining: readonly string[];
  readonly failures: readonly unknown[];
}> {
  const settled = await Promise.allSettled(targets.map(removeIfPresent));
  const remaining: string[] = [];
  const failures: unknown[] = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      const target = targets[index];
      if (target !== undefined) {
        remaining.push(target);
      }
      failures.push(result.reason as unknown);
    }
  });
  return { remaining, failures };
}
