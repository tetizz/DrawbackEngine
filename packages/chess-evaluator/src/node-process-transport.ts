import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { UciTransport } from "./types.js";
import {
  UciProcessExitError,
  UciProcessTerminationError,
  UciTransportError,
} from "./types.js";

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
  #closing = false;
  #spawned = false;
  #processTerminated = false;
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
    this.#process.stdin.on("error", (error) => {
      this.#finish(new UciTransportError("UCI process stdin failed.", {
        cause: error,
      }));
    });
    this.#process.stdout.on("error", (error) => {
      this.#finish(new UciTransportError("UCI process stdout failed.", {
        cause: error,
      }));
    });
    this.#process.stderr.on("error", (error) => {
      this.#finish(new UciTransportError("UCI process stderr failed.", {
        cause: error,
      }));
    });
    this.#process.once("spawn", () => {
      this.#spawned = true;
    });
    this.#process.stdout.on("data", (chunk: string) => {
      this.#consumeStdout(chunk);
    });
    this.#process.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR_LENGTH);
    });
    this.#process.on("error", (error) => {
      if (!this.#spawned && this.#process.pid === undefined) {
        this.#markProcessTerminated();
      }
      this.#finish(
        new UciTransportError("UCI process transport failed.", {
          cause: error,
        }),
      );
    });
    this.#process.once("exit", (code, signal) => {
      this.#markProcessTerminated();
      const detail =
        this.#closing && code === 0
          ? undefined
          : new UciProcessExitError(
              `UCI process exited unexpectedly with code ${String(code)} and signal ${String(signal)}.`,
              this.#stderr.length === 0
                ? undefined
                : {
                    cause: new Error(
                      `UCI stderr ended with ${String(this.#stderr.length)} bytes.`,
                    ),
                  },
            );
      this.#finish(detail);
    });
  }

  public send(command: string): Promise<void> {
    if (this.#ended || this.#process.stdin.destroyed) {
      return Promise.reject(
        this.#failure ?? new UciTransportError("UCI process is closed."),
      );
    }
    if (command.length === 0 || command.includes("\n") || command.includes("\r")) {
      return Promise.reject(
        new RangeError("UCI command must be a non-empty single line."),
      );
    }
    if (command === "quit") {
      this.#closing = true;
    }
    return new Promise((resolve, reject) => {
      this.#process.stdin.write(`${command}\n`, "utf8", (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(
            new UciTransportError("Failed to write a UCI command.", {
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
    if (this.#processTerminated) {
      if (this.#failure !== undefined) {
        throw this.#completedProcessFailure();
      }
      return;
    }
    this.#closing = true;
    if (!this.#process.stdin.destroyed) {
      this.#process.stdin.end();
    }
    if (await this.#waitForExit()) {
      if (this.#failure !== undefined) {
        throw this.#completedProcessFailure();
      }
      return;
    }
    const sentTerminate = this.#process.kill("SIGTERM");
    if (await this.#waitForExit()) {
      throw new UciProcessTerminationError(
        `UCI process did not exit within ${String(this.#shutdownTimeoutMs)}ms and required termination.`,
        true,
        this.#failure === undefined ? undefined : { cause: this.#failure },
      );
    }
    const sentForcedTermination = this.#process.kill("SIGKILL");
    if (!(await this.#waitForExit())) {
      throw new UciProcessTerminationError(
        sentTerminate || sentForcedTermination
          ? "UCI process remained alive after bounded forced termination."
          : "UCI process termination signals could not be delivered and no exit was observed.",
        false,
        this.#failure === undefined ? undefined : { cause: this.#failure },
      );
    }
    throw new UciProcessTerminationError(
      `UCI process did not exit within ${String(this.#shutdownTimeoutMs)}ms and required forced termination.`,
      true,
      this.#failure === undefined ? undefined : { cause: this.#failure },
    );
  }

  async #waitForExit(): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => {
        resolve(false);
      }, this.#shutdownTimeoutMs);
    });
    try {
      return await Promise.race([
        this.#exit.then(() => true as const),
        timedOut,
      ]);
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
  }

  #markProcessTerminated(): void {
    if (this.#processTerminated) {
      return;
    }
    this.#processTerminated = true;
    this.#resolveExit?.();
  }

  #completedProcessFailure(): UciProcessExitError {
    return this.#failure instanceof UciProcessExitError
      ? this.#failure
      : new UciProcessExitError(
          "UCI process terminated after a transport failure.",
          this.#failure === undefined ? undefined : { cause: this.#failure },
        );
  }
}
