import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeJsonLine } from "./json-line-writer.js";

describe("JSON line writer", () => {
  it("writes one canonical newline-terminated record", async () => {
    let output = "";
    const stream = new Writable({
      write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) {
        output += chunk.toString();
        callback();
      },
    });

    await writeJsonLine(stream, { kind: "complete", games: 25 });

    expect(output).toBe('{"kind":"complete","games":25}\n');
  });

  it("waits for a slow destination to accept the record", async () => {
    let release: (() => void) | undefined;
    const stream = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    let completed = false;
    const writing = writeJsonLine(stream, { kind: "progress" }).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    release?.();
    await writing;
    expect(completed).toBe(true);
  });

  it("rejects a broken destination without an unhandled stream error", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        const failure = new Error("injected EPIPE") as NodeJS.ErrnoException;
        failure.code = "EPIPE";
        callback(failure);
      },
    });

    await expect(writeJsonLine(stream, { kind: "progress" }))
      .rejects.toThrow("injected EPIPE");
  });

  it("rejects an interrupted pending write", async () => {
    const controller = new AbortController();
    const stream = new Writable({
      write(
        chunk: Buffer,
        encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) {
        // Deliberately remains pending until the abort is observed.
        void chunk;
        void encoding;
        void callback;
      },
    });
    const writing = writeJsonLine(
      stream,
      { kind: "progress" },
      controller.signal,
    );
    controller.abort(new Error("write interrupted"));

    await expect(writing).rejects.toThrow("write interrupted");
    stream.destroy();
  });
});
