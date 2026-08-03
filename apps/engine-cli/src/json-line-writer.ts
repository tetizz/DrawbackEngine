import type { Writable } from "node:stream";

/** Writes one JSON record while honoring stream backpressure and failures. */
export function writeJsonLine(
  stream: Writable,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (stream.destroyed || stream.writableEnded) {
    return Promise.reject(new Error("JSON output stream is not writable."));
  }
  const line = `${JSON.stringify(value)}\n`;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (retainErrorListener: boolean): void => {
      if (!retainErrorListener) {
        stream.removeListener("error", onError);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const complete = (
      error?: Error | null,
      retainErrorListener = false,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(retainErrorListener);
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onError = (error: Error): void => {
      complete(error);
    };
    const onAbort = (): void => {
      complete(abortFailure(signal), true);
    };
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      stream.write(line, "utf8", (error?: Error | null) => {
        if (settled) {
          signal?.removeEventListener("abort", onAbort);
          if (error === undefined || error === null) {
            stream.removeListener("error", onError);
          }
          return;
        }
        complete(error, error !== undefined && error !== null);
      });
    } catch (error: unknown) {
      complete(errorFromUnknown(error));
    }
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortFailure(signal);
  }
}

function abortFailure(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("JSON output was interrupted.");
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("JSON output failed with a non-Error value.", { cause: error });
}
