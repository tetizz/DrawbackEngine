import type {
  ExternalConstraintResolutionOptions,
  ExternalTurnConstraint,
  ExternalTurnConstraintProvider,
  ExternalTurnConstraintRequest,
} from "@drawbackengine/drawback-engine";
import type { UciClient } from "./client.js";
import { AuthenticatedNodeUciEngineCloseError } from "./authenticated-node-uci-engine.js";
import { ConstraintCache } from "./constraint-cache.js";
import type {
  ConstraintEngineFingerprint,
  ConstraintPolicyIdentity,
  ConstraintRequest,
} from "./constraint-cache.js";
import {
  errorProvesUciProcessTerminated,
  type UciSearchLimit,
} from "./types.js";

const PROVIDER = "uci-best-move";

export class TurnConstraintProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TurnConstraintProviderError";
  }
}

export interface UciTurnConstraintPolicy {
  readonly identity: ConstraintPolicyIdentity;
  readonly fingerprint: ConstraintEngineFingerprint;
  /** Exact `id name` expected from the initialized UCI client. */
  readonly expectedUciName: string;
  readonly publicEngineFingerprint: string;
  readonly limit: UciSearchLimit;
}

export interface UciTurnConstraintProviderOptions {
  /** The caller must initialize and configure this client before construction. */
  readonly client: UciClient;
  readonly policy: UciTurnConstraintPolicy;
  readonly cache?: ConstraintCache;
  /**
   * Optional owner cleanup. Process-backed factories use this to close the
   * authenticated engine and remove its private executable, not only the
   * borrowed client.
   */
  readonly dispose?: () => Promise<void>;
}

function expectedPositionKey(
  fen: string,
  rootMoves: readonly string[],
): string {
  return JSON.stringify([fen, [...rootMoves].sort()]);
}

function cacheRequest(
  request: ExternalTurnConstraintRequest,
  policy: UciTurnConstraintPolicy,
): ConstraintRequest {
  return {
    policy: policy.identity,
    fingerprint: policy.fingerprint,
    fen: request.fen,
    rootMoves: request.ordinaryRootMoves,
    limit: policy.limit,
  };
}

function abortError(): Error {
  const error = new Error("Evaluator constraint resolution was aborted.");
  error.name = "AbortError";
  return error;
}

async function awaitWithAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return pending;
  }
  if (signal.aborted) {
    throw abortError();
  }
  let removeListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = () => {
      signal.removeEventListener("abort", onAbort);
    };
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    removeListener?.();
  }
}

/**
 * Resolves public evaluator facts without receiving a drawback ID, hidden
 * parameters, rule state, player identity, or prediction labels.
 */
export class UciTurnConstraintProvider
implements ExternalTurnConstraintProvider {
  readonly #client: UciClient;
  readonly #policy: UciTurnConstraintPolicy;
  readonly #cache: ConstraintCache;
  readonly #disposeOwnedRuntime: () => Promise<void>;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  #clientQueue: Promise<void> = Promise.resolve();

  public constructor(options: UciTurnConstraintProviderOptions) {
    this.#client = options.client;
    this.#policy = structuredClone(options.policy);
    this.#cache = options.cache ?? new ConstraintCache();
    this.#disposeOwnedRuntime =
      options.dispose ?? (() => this.#client.close());
    if (this.#policy.publicEngineFingerprint.trim().length === 0) {
      throw new RangeError("Public engine fingerprint must not be empty.");
    }
    const identity = this.#client.identity;
    if (identity?.name === null || identity?.name === undefined) {
      throw new TurnConstraintProviderError(
        "Turn constraint client must be initialized with a named UCI engine.",
      );
    }
    if (identity.name !== this.#policy.expectedUciName) {
      throw new TurnConstraintProviderError(
        "Configured engine fingerprint does not match the initialized UCI engine identity.",
      );
    }
  }

  public async resolve(
    request: ExternalTurnConstraintRequest,
    options: ExternalConstraintResolutionOptions = {},
  ): Promise<ExternalTurnConstraint> {
    if (this.#disposed) {
      throw new TurnConstraintProviderError(
        "Turn constraint provider has been disposed.",
      );
    }
    const requestedProvider: unknown = request.provider;
    if (requestedProvider !== PROVIDER) {
      throw new TurnConstraintProviderError(
        `Unsupported turn constraint provider: ${String(requestedProvider)}.`,
      );
    }
    if (request.policyId !== this.#policy.identity.id) {
      throw new TurnConstraintProviderError(
        `Turn constraint policy ${request.policyId} is not configured.`,
      );
    }
    if (
      request.positionKey !== expectedPositionKey(
        request.fen,
        request.ordinaryRootMoves,
      )
    ) {
      throw new TurnConstraintProviderError(
        "Turn constraint position key does not match its position and roots.",
      );
    }
    if (request.ordinaryRootMoves.length === 0) {
      throw new TurnConstraintProviderError(
        "Evaluator constraints require at least one ordinary legal root move.",
      );
    }

    let record;
    try {
      const pending = this.#cache.getOrCompute(
        cacheRequest(request, this.#policy),
        (canonical) =>
          this.#runClientExclusive(async () => {
            await this.#client.reset();
            const evaluation = await this.#client.evaluateFen(
              canonical.fen,
              this.#policy.limit,
              canonical.rootMoves,
            );
            if (evaluation.bestMove === null) {
              throw new TurnConstraintProviderError(
                "Evaluator returned no best move for a nonempty root mask.",
              );
            }
            return evaluation.bestMove;
          }),
      );
      // A caller may stop waiting, but cannot cancel a shared deterministic
      // cache fill that another coalesced caller may still need.
      record = await awaitWithAbort(pending, options.signal);
    } catch (error) {
      if (error instanceof TurnConstraintProviderError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      throw new TurnConstraintProviderError(
        "Evaluator constraint resolution failed.",
        { cause: error },
      );
    }
    if (record.bestMove === null) {
      throw new TurnConstraintProviderError(
        "Cached evaluator constraint has no best move.",
      );
    }
    return Object.freeze({
      provider: PROVIDER,
      policyId: request.policyId,
      positionKey: request.positionKey,
      requestDigest: record.requestDigest,
      bestMoveUci: record.bestMove,
      engineFingerprint: this.#policy.publicEngineFingerprint,
    });
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== null) {
      return this.#disposePromise;
    }
    this.#disposed = true;
    const attempt = (async () => {
      await this.#clientQueue.catch(() => undefined);
      await this.#disposeOwnedRuntime();
    })();
    this.#disposePromise = attempt;
    void attempt.then(
      () => undefined,
      (error: unknown) => {
        if (
          this.#disposePromise === attempt
          && !isCompletedOwnedRuntimeCleanup(error)
        ) {
          this.#disposePromise = null;
        }
      },
    );
    return attempt;
  }

  #runClientExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#clientQueue.then(operation, operation);
    this.#clientQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isCompletedOwnedRuntimeCleanup(error: unknown): boolean {
  if (error instanceof AuthenticatedNodeUciEngineCloseError) {
    return error.privateExecutableRemoved && error.processTerminated;
  }
  return errorProvesUciProcessTerminated(error);
}
