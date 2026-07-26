import type { ChessMove, PieceType } from "@drawbackengine/drawback-engine";
import type { RandomSource } from "@drawbackengine/shared";
import type { AgentView, SimulationAgent } from "./simulation.js";

const PIECE_VALUE: Readonly<Record<PieceType, number>> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: 100,
};

function moveScore(move: ChessMove): number {
  const capture =
    move.captured === undefined
      ? 0
      : PIECE_VALUE[move.captured] - PIECE_VALUE[move.piece] * 0.08;
  const promotion =
    move.promotion === undefined ? 0 : PIECE_VALUE[move.promotion] - 1;
  const check = move.san.includes("#") ? 12 : move.san.includes("+") ? 0.75 : 0;
  const file = move.to.charCodeAt(0) - "a".charCodeAt(0);
  const rank = Number(move.to[1]) - 1;
  const center = 1 - (Math.abs(file - 3.5) + Math.abs(rank - 3.5)) / 7;
  return capture * 2.2 + promotion * 2 + check + center * 0.2;
}

function assertMoves(view: AgentView): readonly ChessMove[] {
  if (view.legalMoves.length === 0) {
    throw new Error("Agent was asked to move without a legal move.");
  }
  return view.legalMoves;
}

function selectHighest(
  moves: readonly ChessMove[],
  rng: RandomSource,
): ChessMove {
  const scored = moves.map((move) => ({ move, score: moveScore(move) }));
  const bestScore = Math.max(...scored.map((item) => item.score));
  const tied = scored.filter((item) => item.score === bestScore);
  const selected = tied[rng.integer(tied.length)]?.move;
  if (selected === undefined) {
    throw new Error("Greedy selection failed to return a move.");
  }
  return selected;
}

export const greedyMaterialAgent: SimulationAgent = {
  id: "greedy-material",
  style: "material",
  strength: 600,
  chooseMove(view, rng) {
    return selectHighest(assertMoves(view), rng);
  },
};

export interface TemperatureAgentOptions {
  readonly id: string;
  readonly temperature: number;
  readonly strength?: number;
}

export function createTemperatureAgent(
  options: TemperatureAgentOptions,
): SimulationAgent {
  if (!Number.isFinite(options.temperature) || options.temperature <= 0) {
    throw new RangeError("temperature must be finite and greater than zero.");
  }
  return {
    id: options.id,
    style: "human-like",
    ...(options.strength === undefined ? {} : { strength: options.strength }),
    chooseMove(view, rng) {
      const moves = assertMoves(view);
      const scores = moves.map(moveScore);
      const maximum = Math.max(...scores);
      const weights = scores.map((score) =>
        Math.exp((score - maximum) / options.temperature),
      );
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let threshold = rng.next() * total;
      for (let index = 0; index < moves.length; index += 1) {
        threshold -= weights[index] ?? 0;
        if (threshold <= 0) {
          const selected = moves[index];
          if (selected !== undefined) {
            return selected;
          }
        }
      }
      const fallback = moves.at(-1);
      if (fallback === undefined) {
        throw new Error("Temperature selection failed to return a move.");
      }
      return fallback;
    },
  };
}

export const weakHumanLikeAgent = createTemperatureAgent({
  id: "human-like-weak",
  temperature: 2.4,
  strength: 800,
});

export const mediumHumanLikeAgent = createTemperatureAgent({
  id: "human-like-medium",
  temperature: 0.9,
  strength: 1400,
});

export const strongHumanLikeAgent = createTemperatureAgent({
  id: "human-like-strong",
  temperature: 0.28,
  strength: 2000,
});
