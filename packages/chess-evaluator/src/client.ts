import { parseBestMove, parseInfo } from "./parser.js";
import type {
  UciClientOptions,
  UciControlOptions,
  UciEngineIdentity,
  UciEvaluation,
  UciEvaluationOptions,
  UciOptionSetting,
  UciSearchInfo,
  UciSearchLimit,
  UciTransport,
} from "./types.js";
import {
  errorProvesUciProcessTerminated,
  UciProcessExitError,
  UciProtocolError,
  UciTimeoutError,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/u;
const UCI_OPTION = /^option name (.+?) type (\S+)(?: |$)/u;

interface AdvertisedOption {
  readonly name: string;
  readonly type: string;
}

function validateLimit(limit: UciSearchLimit): string {
  const [name, value] =
    "depth" in limit
      ? ["depth", limit.depth] as const
      : "moveTimeMs" in limit
        ? ["movetime", limit.moveTimeMs] as const
        : ["nodes", limit.nodes] as const;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("UCI search limit must be a positive safe integer.");
  }
  return `${name} ${String(value)}`;
}

function validateRootMoves(rootMoves: readonly string[]): string {
  const unique = new Set<string>();
  for (const move of rootMoves) {
    if (!UCI_MOVE.test(move)) {
      throw new RangeError(`Invalid UCI root move: ${move}.`);
    }
    if (unique.has(move)) {
      throw new RangeError(`Duplicate UCI root move: ${move}.`);
    }
    unique.add(move);
  }
  return rootMoves.length === 0 ? "" : ` searchmoves ${rootMoves.join(" ")}`;
}

export class UciClient {
  readonly #transport: UciTransport;
  readonly #iterator: AsyncIterator<string>;
  readonly #timeoutMs: number;
  readonly #initialOptions: readonly UciOptionSetting[];
  readonly #advertisedOptions = new Map<string, AdvertisedOption>();
  readonly #configuredOptions = new Map<
    string,
    string | number | boolean
  >();
  #pendingRead: Promise<IteratorResult<string>> | null = null;
  #initialized = false;
  #identity: UciEngineIdentity | null = null;
  #searching = false;
  #controlling = false;
  #poisoned = false;
  #closed = false;
  #quitAttempted = false;
  #transportCloseComplete = false;
  #terminalCloseFailure: Error | undefined;
  #closeAttempt: Promise<void> | undefined;

  public constructor(transport: UciTransport, options: UciClientOptions = {}) {
    this.#transport = transport;
    this.#iterator = transport.lines()[Symbol.asyncIterator]();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#initialOptions = options.options === undefined
      ? []
      : [...options.options];
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer.");
    }
    for (const option of this.#initialOptions) {
      validateOptionSetting(option);
    }
  }

  public get identity(): UciEngineIdentity | null {
    return this.#identity === null
      ? null
      : {
          ...this.#identity,
          options: [...this.#identity.options],
        };
  }

  public configuredOption(
    name: string,
  ): string | number | boolean | undefined {
    return this.#configuredOptions.get(name.toLowerCase());
  }

  public async initialize(
    options: UciControlOptions = {},
  ): Promise<UciEngineIdentity> {
    this.#assertOpen();
    if (this.#poisoned) {
      throw new UciProtocolError(
        "UCI client is unusable after an incomplete protocol operation.",
      );
    }
    if (this.#initialized) {
      throw new UciProtocolError("UCI client is already initialized.");
    }
    if (this.#controlling) {
      throw new UciProtocolError("Another UCI control operation is in progress.");
    }
    this.#controlling = true;
    const deadlineMs = performance.now() + this.#timeoutMs;
    try {
      await this.#sendBeforeDeadline(
        "uci",
        deadlineMs,
        "UCI initialization command",
        options.signal,
      );
      let name: string | null = null;
      let author: string | null = null;
      const advertisedOptionLines: string[] = [];
      for (;;) {
        const line = await this.#nextLine(
          "uciok",
          options.signal,
          deadlineMs,
        );
        if (line === "uciok") {
          break;
        }
        if (line.startsWith("id name ")) {
          name = line.slice("id name ".length);
        } else if (line.startsWith("id author ")) {
          author = line.slice("id author ".length);
        } else if (line.startsWith("option ")) {
          advertisedOptionLines.push(line);
          this.#rememberOption(line);
        }
      }
      await this.#sendOptions(
        this.#initialOptions,
        deadlineMs,
        options.signal,
      );
      await this.#readinessBarrier(deadlineMs, options.signal);
      this.#initialized = true;
      const identity: UciEngineIdentity = {
        name,
        author,
        options: [...advertisedOptionLines],
      };
      this.#identity = Object.freeze(identity);
      return { ...identity, options: [...identity.options] };
    } catch (error) {
      this.#poisoned = true;
      throw error;
    } finally {
      this.#controlling = false;
    }
  }

  public async configureOptions(
    options: readonly UciOptionSetting[],
    control: UciControlOptions = {},
  ): Promise<void> {
    this.#beginControl();
    const deadlineMs = performance.now() + this.#timeoutMs;
    try {
      await this.#sendOptions(options, deadlineMs, control.signal);
      await this.#readinessBarrier(deadlineMs, control.signal);
    } catch (error) {
      this.#poisoned = true;
      throw error;
    } finally {
      this.#controlling = false;
    }
  }

  public async ready(options: UciControlOptions = {}): Promise<void> {
    this.#beginControl();
    const deadlineMs = performance.now() + this.#timeoutMs;
    try {
      await this.#readinessBarrier(deadlineMs, options.signal);
    } catch (error) {
      this.#poisoned = true;
      throw error;
    } finally {
      this.#controlling = false;
    }
  }

  /**
   * Starts a position-independent engine epoch by clearing both game state and
   * the transposition table before the readiness barrier.
   */
  public async reset(options: UciControlOptions = {}): Promise<void> {
    this.#beginControl();
    const deadlineMs = performance.now() + this.#timeoutMs;
    try {
      await this.#sendBeforeDeadline(
        "ucinewgame",
        deadlineMs,
        "new-game command",
        options.signal,
      );
      await this.#sendOptions(
        [{ name: "Clear Hash" }],
        deadlineMs,
        options.signal,
      );
      await this.#readinessBarrier(deadlineMs, options.signal);
    } catch (error) {
      this.#poisoned = true;
      throw error;
    } finally {
      this.#controlling = false;
    }
  }

  public async newGame(options: UciControlOptions = {}): Promise<void> {
    this.#beginControl();
    const deadlineMs = performance.now() + this.#timeoutMs;
    try {
      await this.#sendBeforeDeadline(
        "ucinewgame",
        deadlineMs,
        "new-game command",
        options.signal,
      );
      await this.#readinessBarrier(deadlineMs, options.signal);
    } catch (error) {
      this.#poisoned = true;
      throw error;
    } finally {
      this.#controlling = false;
    }
  }

  public async evaluateFen(
    fen: string,
    limit: UciSearchLimit,
    rootMoves: readonly string[] = [],
    options: UciEvaluationOptions = {},
  ): Promise<UciEvaluation> {
    this.#assertReady();
    if (this.#searching) {
      throw new UciProtocolError("Concurrent UCI searches are not supported.");
    }
    if (this.#controlling) {
      throw new UciProtocolError(
        "A UCI control operation is already in progress.",
      );
    }
    if (options.signal?.aborted === true) {
      throw createAbortError();
    }
    const normalizedFen = fen.trim();
    if (normalizedFen.length === 0 || normalizedFen.includes("\n")) {
      throw new RangeError("FEN must be a non-empty single line.");
    }
    const go = validateLimit(limit);
    const searchMoves = validateRootMoves(rootMoves);
    const deadlineMs = performance.now() + this.#timeoutMs;
    this.#searching = true;
    try {
      await this.#sendBeforeDeadline(
        `position fen ${normalizedFen}`,
        deadlineMs,
        "position setup",
        options.signal,
      );
      await this.#sendBeforeDeadline(
        `go ${go}${searchMoves}`,
        deadlineMs,
        "search start",
        options.signal,
      );
      let latestInfo: UciSearchInfo | null = null;
      let cancelled = false;
      for (;;) {
        const event = await this.#nextSearchEvent(
          "bestmove",
          cancelled ? undefined : options.signal,
          deadlineMs,
        );
        if (event.kind === "abort") {
          cancelled = true;
          await this.#sendBeforeDeadline("stop", deadlineMs, "search stop");
          continue;
        }
        const line = event.line;
        const info = parseInfo(line);
        if (info !== null) {
          latestInfo = info;
          continue;
        }
        const best = parseBestMove(line);
        if (best !== null) {
          if (cancelled) {
            throw createAbortError();
          }
          if (
            best.bestMove !== null
            && rootMoves.length > 0
            && !rootMoves.includes(best.bestMove)
          ) {
            throw new UciProtocolError(
              `Engine best move ${best.bestMove} is outside the requested root moves.`,
            );
          }
          return {
            ...best,
            score: latestInfo?.score ?? null,
            depth: latestInfo?.depth ?? null,
            nodes: latestInfo?.nodes ?? null,
            principalVariation: latestInfo?.principalVariation ?? [],
          };
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        this.#poisoned = true;
      }
      throw error;
    } finally {
      this.#searching = false;
    }
  }

  public close(): Promise<void> {
    if (this.#terminalCloseFailure !== undefined) {
      return Promise.reject(this.#terminalCloseFailure);
    }
    if (this.#transportCloseComplete) {
      return Promise.resolve();
    }
    if (this.#closeAttempt !== undefined) {
      return this.#closeAttempt;
    }
    this.#closed = true;
    const attempt = this.#closeOnce();
    this.#closeAttempt = attempt;
    void attempt.then(
      () => {
        if (this.#closeAttempt === attempt) {
          this.#closeAttempt = undefined;
        }
      },
      () => {
        if (this.#closeAttempt === attempt) {
          this.#closeAttempt = undefined;
        }
      },
    );
    return attempt;
  }

  async #closeOnce(): Promise<void> {
    let quitFailure: Error | undefined;
    if (!this.#quitAttempted) {
      this.#quitAttempted = true;
      try {
        await this.#sendBeforeDeadline(
          "quit",
          performance.now() + this.#timeoutMs,
          "quit command",
        );
      } catch (error: unknown) {
        quitFailure = protocolFailure(
          error,
          "UCI transport rejected the quit command.",
        );
      }
    }
    let closeFailure: Error | undefined;
    try {
      await this.#transport.close();
      this.#transportCloseComplete = true;
    } catch (error: unknown) {
      closeFailure = protocolFailure(
        error,
        "UCI transport shutdown failed.",
      );
      if (errorProvesUciProcessTerminated(closeFailure)) {
        this.#transportCloseComplete = true;
      }
    }
    const failure = quitFailure === undefined
      ? closeFailure
      : closeFailure === undefined
        ? quitFailure
        : new AggregateError(
            [quitFailure, closeFailure],
            "UCI quit command and transport shutdown both failed.",
          );
    if (failure !== undefined) {
      if (this.#transportCloseComplete) {
        this.#terminalCloseFailure = errorProvesUciProcessTerminated(failure)
          ? failure
          : new UciProcessExitError(
              "UCI process terminated after a shutdown failure.",
              { cause: failure },
            );
        throw this.#terminalCloseFailure;
      }
      throw failure;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new UciProtocolError("UCI client is closed.");
    }
  }

  #assertReady(): void {
    this.#assertOpen();
    if (this.#poisoned) {
      throw new UciProtocolError(
        "UCI client is unusable after an incomplete protocol operation.",
      );
    }
    if (!this.#initialized) {
      throw new UciProtocolError("UCI client must be initialized first.");
    }
  }

  #beginControl(): void {
    this.#assertReady();
    if (this.#searching || this.#controlling) {
      throw new UciProtocolError(
        "Another UCI operation is already in progress.",
      );
    }
    this.#controlling = true;
  }

  #rememberOption(line: string): void {
    const match = UCI_OPTION.exec(line);
    if (match === null) {
      throw new UciProtocolError(`Malformed UCI option declaration: ${line}`);
    }
    const [, name, type] = match;
    if (name === undefined || type === undefined) {
      throw new UciProtocolError(`Malformed UCI option declaration: ${line}`);
    }
    const key = name.toLowerCase();
    if (this.#advertisedOptions.has(key)) {
      throw new UciProtocolError(`Engine advertised duplicate option: ${name}.`);
    }
    this.#advertisedOptions.set(key, { name, type });
  }

  async #sendOptions(
    options: readonly UciOptionSetting[],
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const commands = options.map((setting) => {
      validateOptionSetting(setting);
      const advertised = this.#advertisedOptions.get(
        setting.name.toLowerCase(),
      );
      if (advertised === undefined) {
        throw new UciProtocolError(
          `Engine does not advertise required UCI option: ${setting.name}.`,
        );
      }
      const hasValue = setting.value !== undefined;
      if (advertised.type === "button" && hasValue) {
        throw new UciProtocolError(
          `UCI button option ${advertised.name} does not accept a value.`,
        );
      }
      if (advertised.type !== "button" && !hasValue) {
        throw new UciProtocolError(
          `UCI option ${advertised.name} requires a value.`,
        );
      }
      const suffix = hasValue ? ` value ${String(setting.value)}` : "";
      return {
        command: `setoption name ${advertised.name}${suffix}`,
        key: setting.name.toLowerCase(),
        value: setting.value,
      };
    });
    for (const { command, key, value } of commands) {
      await this.#sendBeforeDeadline(
        command,
        deadlineMs,
        `UCI option ${key}`,
        signal,
      );
      if (value !== undefined) {
        this.#configuredOptions.set(key, value);
      }
    }
  }

  async #readinessBarrier(
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#sendBeforeDeadline(
      "isready",
      deadlineMs,
      "readiness command",
      signal,
    );
    for (;;) {
      if (
        (await this.#nextLine("readyok", signal, deadlineMs)) === "readyok"
      ) {
        return;
      }
    }
  }

  async #nextLine(
    waitingFor: string,
    signal?: AbortSignal,
    deadlineMs?: number,
  ): Promise<string> {
    const event = await this.#nextSearchEvent(
      waitingFor,
      signal,
      deadlineMs,
    );
    if (event.kind === "abort") {
      throw createAbortError();
    }
    return event.line;
  }

  async #nextSearchEvent(
    waitingFor: string,
    signal?: AbortSignal,
    deadlineMs?: number,
  ): Promise<{ readonly kind: "line"; readonly line: string } | {
    readonly kind: "abort";
  }> {
    const timeoutMs = deadlineMs === undefined
      ? this.#timeoutMs
      : deadlineMs - performance.now();
    if (timeoutMs <= 0) {
      this.#poisoned = true;
      throw this.#timeoutError(waitingFor);
    }
    const read = this.#pendingRead ?? this.#iterator.next();
    this.#pendingRead = read;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    const timeoutPromise = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => {
        resolve({ kind: "timeout" });
      }, timeoutMs);
    });
    const readPromise = read.then((result) => ({
      kind: "read" as const,
      result,
    }));
    const abortPromise =
      signal === undefined
        ? new Promise<never>(() => undefined)
        : new Promise<{ readonly kind: "abort" }>((resolve) => {
            const onAbort = (): void => {
              resolve({ kind: "abort" });
            };
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => {
              signal.removeEventListener("abort", onAbort);
            };
            if (signal.aborted) {
              onAbort();
            }
          });
    try {
      const result = await Promise.race([
        readPromise,
        timeoutPromise,
        abortPromise,
      ]);
      if (result.kind === "abort") {
        return result;
      }
      if (result.kind === "timeout") {
        this.#poisoned = true;
        throw this.#timeoutError(waitingFor);
      }
      this.#pendingRead = null;
      if (result.result.done) {
        this.#poisoned = true;
        throw new UciProtocolError(
          `UCI transport ended while waiting for ${waitingFor}.`,
        );
      }
      return { kind: "line", line: result.result.value.trim() };
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      removeAbortListener?.();
    }
  }

  async #sendBeforeDeadline(
    command: string,
    deadlineMs: number,
    waitingFor: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted === true) {
      throw createAbortError();
    }
    const timeoutMs = deadlineMs - performance.now();
    if (timeoutMs <= 0) {
      this.#poisoned = true;
      throw this.#timeoutError(waitingFor);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        resolve("timeout");
      }, timeoutMs);
    });
    const abortPromise = signal === undefined
      ? new Promise<never>(() => undefined)
      : new Promise<"abort">((resolve) => {
          const onAbort = (): void => {
            resolve("abort");
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => {
            signal.removeEventListener("abort", onAbort);
          };
          if (signal.aborted) {
            onAbort();
          }
        });
    const sendState = { completed: false };
    const send = this.#transport.send(command).then(() => {
      sendState.completed = true;
      return "sent" as const;
    });
    try {
      const result = await Promise.race([
        send,
        timeoutPromise,
        abortPromise,
      ]);
      if (result === "timeout") {
        this.#poisoned = true;
        this.#beginDetachedClose();
        throw this.#timeoutError(waitingFor);
      }
      if (result === "abort") {
        // If the write completed in the same turn, the caller must continue
        // into the normal stop/drain path. Otherwise dispatch is unknowable,
        // so the client is poisoned and its transport is closed independently.
        await Promise.resolve();
        if (sendState.completed) {
          return;
        }
        this.#poisoned = true;
        this.#beginDetachedClose();
        throw createAbortError();
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      removeAbortListener?.();
    }
  }

  #beginDetachedClose(): void {
    void this.close().catch(() => {
      // The owner can call close again to retry incomplete process cleanup.
    });
  }

  #timeoutError(waitingFor: string): UciTimeoutError {
    return new UciTimeoutError(
      `Timed out after ${String(this.#timeoutMs)}ms waiting for ${waitingFor}.`,
    );
  }
}

function validateOptionSetting(option: UciOptionSetting): void {
  const name = option.name.trim();
  if (name.length === 0 || name !== option.name || /[\r\n]/u.test(name)) {
    throw new RangeError(
      "UCI option names must be non-empty, trimmed, and single-line.",
    );
  }
  if (
    option.value !== undefined
    && (typeof option.value === "string"
      ? /[\r\n]/u.test(option.value)
      : typeof option.value === "number" && !Number.isFinite(option.value))
  ) {
    throw new RangeError("UCI option values must be finite and single-line.");
  }
}

function createAbortError(): Error {
  const error = new Error("UCI search was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function protocolFailure(error: unknown, message: string): Error {
  return error instanceof Error
    ? error
    : new UciProtocolError(message, { cause: error });
}
