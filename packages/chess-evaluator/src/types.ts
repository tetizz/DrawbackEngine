export interface UciTransport {
  send(command: string): Promise<void>;
  lines(): AsyncIterable<string>;
  close(): Promise<void>;
}

export interface UciEngineIdentity {
  readonly name: string | null;
  readonly author: string | null;
  readonly options: readonly string[];
}

export type UciScore =
  | {
      readonly kind: "centipawns";
      readonly value: number;
      readonly bound: "exact" | "lower" | "upper";
    }
  | {
      readonly kind: "mate";
      readonly moves: number;
      readonly bound: "exact" | "lower" | "upper";
    };

export interface UciSearchInfo {
  readonly depth: number | null;
  readonly selectiveDepth: number | null;
  readonly nodes: number | null;
  readonly score: UciScore | null;
  readonly principalVariation: readonly string[];
}

export interface UciEvaluation {
  readonly bestMove: string | null;
  readonly ponderMove: string | null;
  /**
   * UCI scores are relative to the side to move in the supplied FEN.
   */
  readonly score: UciScore | null;
  readonly depth: number | null;
  readonly nodes: number | null;
  readonly principalVariation: readonly string[];
}

export type UciSearchLimit =
  | { readonly depth: number }
  | { readonly moveTimeMs: number }
  | { readonly nodes: number };

export type UciOptionSetting =
  | {
      readonly name: string;
      readonly value: string | number | boolean;
    }
  | {
      readonly name: string;
      readonly value?: never;
    };

export interface UciEvaluationOptions {
  readonly signal?: AbortSignal;
}

export interface UciControlOptions {
  readonly signal?: AbortSignal;
}

export interface UciClientOptions {
  readonly timeoutMs?: number;
  /**
   * Required engine options applied after `uciok` and before the first
   * readiness barrier. Initialization fails if the engine did not advertise
   * one of these options.
   */
  readonly options?: readonly UciOptionSetting[];
}

export class UciProtocolError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UciProtocolError";
  }
}

/**
 * A process or transport failure that can be retried with the exact same
 * authenticated request in a fresh engine process. Malformed UCI output
 * remains a plain UciProtocolError and is intentionally not retryable.
 */
export class UciTransportError extends UciProtocolError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UciTransportError";
  }
}

export class UciTimeoutError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UciTimeoutError";
  }
}

export class UciProcessTerminationError extends UciTimeoutError {
  public constructor(
    message: string,
    public readonly processTerminated: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UciProcessTerminationError";
  }
}

export class UciProcessExitError extends UciTransportError {
  public readonly processTerminated = true;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UciProcessExitError";
  }
}

/** Returns true only when typed error evidence proves the process exited. */
export function errorProvesUciProcessTerminated(value: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [value];
  let provedTermination = false;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof UciProcessTerminationError) {
      if (!current.processTerminated) {
        return false;
      }
      provedTermination = true;
    } else if (current instanceof UciProcessExitError) {
      provedTermination = true;
    }
    if (current instanceof AggregateError) {
      for (const nested of current.errors as readonly unknown[]) {
        pending.push(nested);
      }
    }
    if (current instanceof Error && current.cause !== undefined) {
      pending.push(current.cause);
    }
  }
  return provedTermination;
}
