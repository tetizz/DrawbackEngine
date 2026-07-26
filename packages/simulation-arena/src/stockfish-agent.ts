import type {
  UciClient,
  UciSearchLimit,
} from "@drawbackengine/chess-evaluator";
import type { ChessMove, PromotionPiece } from "@drawbackengine/drawback-engine";
import type { AsyncSimulationAgent } from "./async-simulation.js";

const PROMOTION_SYMBOL: Readonly<Record<PromotionPiece, string>> = {
  knight: "n",
  bishop: "b",
  rook: "r",
  queen: "q",
};

export interface StockfishAgentOptions {
  /**
   * A borrowed, initialized client. The caller owns newGame() and close().
   */
  readonly client: UciClient;
  readonly limit: UciSearchLimit;
  readonly id?: string;
}

export function toUciMove(move: ChessMove): string {
  const promotion =
    move.promotion === undefined ? "" : PROMOTION_SYMBOL[move.promotion];
  return `${move.from}${move.to}${promotion}`;
}

export function createStockfishAgent(
  options: StockfishAgentOptions,
): AsyncSimulationAgent {
  return {
    id: options.id ?? "stockfish",
    async chooseMove(view, rng) {
      void rng;
      if (view.legalMoves.length === 0) {
        throw new Error("Stockfish agent was asked to move without a legal move.");
      }
      const rootMoves = view.legalMoves.map(toUciMove);
      const evaluation = await options.client.evaluateFen(
        view.fen,
        options.limit,
        rootMoves,
      );
      if (evaluation.bestMove === null) {
        throw new Error(
          "Stockfish returned no best move for a position with drawback-legal moves.",
        );
      }
      const selected = view.legalMoves.find(
        (move) => toUciMove(move) === evaluation.bestMove,
      );
      if (selected === undefined) {
        throw new Error(
          `Stockfish returned ${evaluation.bestMove}, which is outside the drawback-legal root mask.`,
        );
      }
      return selected;
    },
  };
}
