import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { UciTransport } from "./types.js";
import { UciProtocolError, UciTimeoutError } from "./types.js";

export interface NodeProcessTransportOptions {
  readonly executablePath: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly shutdownTimeoutMs?: number;
}

interface PendingRead {
  readonly resolve: (result: IteratorResult<string>) => void;
  readonly reject: (reason: Error) => void;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_STDERR_LENGTH = 8_192;

/**
 * Explicit Node-only transport for a local UCI executable.
 *
 * The process is launched directly with `shell: false`; callers must provide
 * the executable path and are responsible for acquiring Stockfish.
 */
export class NodeProcessUciTransport implements UciTransport {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #lines: string[] = [];
  readonly #readers: PendingRead[] = [];
  readonly #shutdownTimeoutMs: number;
  readonly #exit: Promise<void>;
  #resolveExit: (() => void) | undefined;
  #buffer = "";
  #stderr = "";
  #ended = false;
  #failure: Error | undefined;

  public constructor(options: NodeProcessTransportOptions) {
    if (options.executablePath.trim().length === 0) {
      throw new RangeError("executablePath must be a non-empty path.");
    }
    this.#shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#shutdownTimeoutMs) ||
      this.#shutdownTimeoutMs <= 0
    ) {
      throw new RangeError(
        "shutdownTimeoutMs must be a positive safe integer.",
      );
    }
    this.#exit = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#process = spawn(options.executablePath, [...(options.args ?? [])], {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#process.stdout.setEncoding("utf8");
    this.#process.stderr.setEncoding("utf8");
    this.#process.stdout.on("data", (chunk: string) => {
      this.#consumeStdout(chunk);
    });
    this.#process.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR_LENGTH);
    });
    this.#process.once("error", (error) => {
      this.#finish(
        new UciProtocolError(`UCI process failed: ${error.message}`, {
          cause: error,
        }),
      );
    });
    this.#process.once("exit", (code, signal) => {
      const detail =
        code === 0
          ? undefined
          : new UciProtocolError(
              `UCI process exited with code ${String(code)} and signal ${String(signal)}${this.#stderr.length === 0 ? "." : `: ${this.#stderr.trim()}`}`,
            );
      this.#finish(detail);
    });
  }

  public send(command: string): Promise<void> {
    if (this.#ended || this.#process.stdin.destroyed) {
      return Promise.reject(
        this.#failure ?? new UciProtocolError("UCI process is closed."),
      );
    }
    if (command.length === 0 || command.includes("\n") || command.includes("\r")) {
      return Promise.reject(
        new RangeError("UCI command must be a non-empty single line."),
      );
    }
    return new Promise((resolve, reject) => {
      this.#process.stdin.write(`${command}\n`, "utf8", (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(
            new UciProtocolError(`Failed to write UCI command: ${error.message}`, {
              cause: error,
            }),
          );
        }
      });
    });
  }

  public lines(): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.#read(),
      }),
    };
  }

  public async close(): Promise<void> {
    if (this.#ended) {
      return;
    }
    this.#process.stdin.end();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        resolve("timeout");
      }, this.#shutdownTimeoutMs);
    });
    try {
      if ((await Promise.race([this.#exit.then(() => "exit" as const), timedOut])) === "timeout") {
        this.#process.kill();
        await this.#exit;
        throw new UciTimeoutError(
          `UCI process did not exit within ${String(this.#shutdownTimeoutMs)}ms.`,
        );
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  #consumeStdout(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#enqueue(line);
    }
  }

  #enqueue(line: string): void {
    const reader = this.#readers.shift();
    if (reader === undefined) {
      this.#lines.push(line);
    } else {
      reader.resolve({ done: false, value: line });
    }
  }

  #read(): Promise<IteratorResult<string>> {
    const line = this.#lines.shift();
    if (line !== undefined) {
      return Promise.resolve({ done: false, value: line });
    }
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.#readers.push({ resolve, reject });
    });
  }

  #finish(failure?: Error): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#failure = failure;
    for (const reader of this.#readers.splice(0)) {
      if (failure === undefined) {
        reader.resolve({ done: true, value: undefined });
      } else {
        reader.reject(failure);
      }
    }
    this.#resolveExit?.();
  }
}
