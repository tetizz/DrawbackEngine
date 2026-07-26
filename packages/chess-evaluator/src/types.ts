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

export class UciTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UciTimeoutError";
  }
}
