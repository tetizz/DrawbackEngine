import { Chess } from "chess.js";
import type {
  DrawbackLeafEvaluator,
  LeafPosition,
} from "@drawbackengine/drawback-search";
import { UnsupportedDrawbackLeafPositionError } from "@drawbackengine/drawback-search";
import type { UciClient } from "./client.js";
import type { UciScore } from "./types.js";

const MATE_SCORE = 900_000;

export interface StockfishLeafEvaluatorOptions {
  /**
   * Borrowed and initialized UCI client. Calls are intentionally serialized.
   */
  readonly client: UciClient;
  /**
   * A completed fixed-depth iteration yields an exact score. Fixed-node
   * searches may stop during an aspiration window and return only a bound.
   */
  readonly depth: number;
  readonly id?: string;
}

export class UnsupportedDrawbackLeafError
  extends UnsupportedDrawbackLeafPositionError {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedDrawbackLeafError";
  }
}

export class StockfishLeafEvaluatorError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StockfishLeafEvaluatorError";
  }
}

/**
 * Stockfish is a leaf chess evaluator only. The outer drawback search owns
 * every real tree transition, hidden rule state, king capture, and loss.
 */
export function createStockfishLeafEvaluator(
  options: StockfishLeafEvaluatorOptions,
): DrawbackLeafEvaluator {
  if (!Number.isSafeInteger(options.depth) || options.depth <= 0) {
    throw new RangeError("Stockfish leaf depth must be a positive integer.");
  }
  let queue: Promise<void> = Promise.resolve();
  const evaluator: DrawbackLeafEvaluator = {
    id: options.id ?? `stockfish-leaf/depth-${String(options.depth)}`,
    evaluate(position, signal) {
      const task = queue.then(async () => {
        throwIfAborted(signal);
        return evaluateWithStockfish(options, position, signal);
      });
      queue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
  };
  return evaluator;
}

async function evaluateWithStockfish(
  options: StockfishLeafEvaluatorOptions,
  position: LeafPosition,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (!position.orthodoxCompatible) {
    throw new UnsupportedDrawbackLeafError(
      "Stockfish cannot evaluate a non-orthodox Drawback Chess leaf.",
    );
  }
  const rootMoves = orthodoxRootMoves(position);
  if (rootMoves === null || rootMoves.length === 0) {
    throw new UnsupportedDrawbackLeafError(
      "Stockfish cannot evaluate a leaf whose exact drawback move set contains non-orthodox moves.",
    );
  }
  await options.client.reset();
  const evaluation = await options.client.evaluateFen(
    position.fen,
    { depth: options.depth },
    rootMoves,
    { ...(signal === undefined ? {} : { signal }) },
  );
  if (evaluation.score === null) {
    throw new StockfishLeafEvaluatorError(
      "Stockfish returned no score for the exact leaf request.",
    );
  }
  if (evaluation.score.bound !== "exact") {
    throw new StockfishLeafEvaluatorError(
      `Stockfish returned a ${evaluation.score.bound} bound instead of an exact leaf score.`,
    );
  }
  return normalizeScore(evaluation.score);
}

function orthodoxRootMoves(position: LeafPosition): readonly string[] | null {
  let chess: Chess;
  try {
    chess = new Chess(position.fen);
  } catch {
    return [];
  }
  const legal = new Set(
    chess.moves({ verbose: true }).map((move) =>
      `${move.from}${move.to}${move.promotion ?? ""}`,
    ),
  );
  const exact = new Set(
    position.legalMoves
      .map((move) =>
        `${move.from}${move.to}${promotionSymbol(move.promotion)}`,
      ),
  );
  const compatible = [...exact].filter((move) => legal.has(move)).sort();
  return compatible.length === exact.size ? compatible : null;
}

function promotionSymbol(
  promotion: LeafPosition["legalMoves"][number]["promotion"],
): string {
  switch (promotion) {
    case undefined:
      return "";
    case "knight":
      return "n";
    case "bishop":
      return "b";
    case "rook":
      return "r";
    case "queen":
      return "q";
  }
}

function normalizeScore(score: UciScore): number {
  if (score.kind === "centipawns") {
    return score.value;
  }
  const distance = Math.min(Math.abs(score.moves), MATE_SCORE - 1);
  return score.moves >= 0 ? MATE_SCORE - distance : -MATE_SCORE + distance;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("Stockfish leaf evaluation was aborted.", "AbortError");
  }
}
