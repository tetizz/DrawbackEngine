import type {
  DrawbackGameSession,
  MoveCommand,
  SessionResult,
} from "@drawbackengine/chess-core";
import type { ChessMove } from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";
import type {
  DrawbackLeafEvaluator,
  DrawbackRootMoveSearchResult,
  DrawbackSearchLimits,
  DrawbackSearchResult,
} from "./types.js";

const TERMINAL_SCORE = 1_000_000;
const INFINITY = TERMINAL_SCORE + 100_000;
const CAPTURE_VALUE: Readonly<Record<NonNullable<ChessMove["captured"]>, number>> = {
  pawn: 100,
  knight: 320,
  bishop: 330,
  rook: 500,
  queen: 900,
  king: TERMINAL_SCORE,
};

interface SearchState {
  readonly rootColor: PlayerColor;
  readonly evaluator: DrawbackLeafEvaluator;
  readonly limits: DrawbackSearchLimits;
  nodes: number;
  leaves: number;
  truncated: boolean;
}

interface NodeResult {
  readonly score: number;
  readonly principalVariation: readonly ChessMove[];
}

type OmniscientSession = DrawbackGameSession<
  unknown,
  unknown,
  unknown,
  unknown
>;

export async function searchOmniscientDrawbackMove(
  session: OmniscientSession,
  evaluator: DrawbackLeafEvaluator,
  limits: DrawbackSearchLimits,
): Promise<DrawbackSearchResult> {
  validateLimits(limits);
  throwIfAborted(limits.signal);
  if (session.result.kind !== "active") {
    throw new Error("Cannot search a completed Drawback Chess session.");
  }
  const rootMoves = orderedMoves(session.legalMoves());
  if (rootMoves.length === 0) {
    throw new Error("Active Drawback Chess session has no legal moves.");
  }
  const state: SearchState = {
    rootColor: session.turn,
    evaluator,
    limits,
    nodes: 1,
    leaves: 0,
    truncated: false,
  };

  let bestMove: ChessMove | null = null;
  let bestScore = -INFINITY;
  let bestLine: readonly ChessMove[] = [];
  let alpha = -INFINITY;
  for (const move of rootMoves) {
    throwIfAborted(limits.signal);
    if (bestMove !== null && state.nodes >= limits.maxNodes) {
      state.truncated = true;
      break;
    }
    const child = session.fork();
    applySearchMove(child, move);
    const result = await searchNode(
      child,
      limits.depth - 1,
      alpha,
      INFINITY,
      1,
      state,
    );
    if (
      bestMove === null
      || result.score > bestScore
      || (
        result.score === bestScore
        && moveId(move).localeCompare(moveId(bestMove)) < 0
      )
    ) {
      bestMove = move;
      bestScore = result.score;
      bestLine = [move, ...result.principalVariation];
    }
    alpha = Math.max(alpha, bestScore);
  }
  if (bestMove === null) {
    throw new Error("Drawback search failed to select a root move.");
  }
  return {
    move: bestMove,
    score: bestScore,
    principalVariation: bestLine,
    nodes: state.nodes,
    leaves: state.leaves,
    truncated: state.truncated,
    rootColor: state.rootColor,
    evaluatorId: evaluator.id,
    knowledgeMode: "omniscient-oracle",
  };
}

/**
 * Scores one exact drawback-legal root with a full alpha-beta window.
 *
 * Unlike the multi-root selector, this result can be used in a complete root
 * score distribution because it cannot inherit a bound from a sibling.
 */
export async function searchOmniscientDrawbackRootMove(
  session: OmniscientSession,
  rootMove: Pick<ChessMove, "from" | "to" | "promotion">,
  evaluator: DrawbackLeafEvaluator,
  limits: DrawbackSearchLimits,
): Promise<DrawbackRootMoveSearchResult> {
  validateLimits(limits);
  throwIfAborted(limits.signal);
  if (session.result.kind !== "active") {
    throw new Error("Cannot search a completed Drawback Chess session.");
  }
  const move = session.legalMoves().find((candidate) =>
    sameMove(candidate, rootMove)
  );
  if (move === undefined) {
    throw new RangeError(
      `Root move ${moveId(rootMove)} is not drawback-legal.`,
    );
  }
  const state: SearchState = {
    rootColor: session.turn,
    evaluator,
    limits,
    nodes: 1,
    leaves: 0,
    truncated: false,
  };
  const child = session.fork();
  applySearchMove(child, move);
  const result = await searchNode(
    child,
    limits.depth - 1,
    -INFINITY,
    INFINITY,
    1,
    state,
  );
  return Object.freeze({
    move: structuredClone(move),
    score: result.score,
    principalVariation: Object.freeze(
      structuredClone([move, ...result.principalVariation]),
    ),
    nodes: state.nodes,
    leaves: state.leaves,
    truncated: state.truncated,
    rootColor: state.rootColor,
    evaluatorId: evaluator.id,
    knowledgeMode: "omniscient-oracle",
    depth: limits.depth,
  });
}

async function searchNode(
  session: OmniscientSession,
  depth: number,
  alphaInput: number,
  betaInput: number,
  ply: number,
  state: SearchState,
): Promise<NodeResult> {
  throwIfAborted(state.limits.signal);
  if (state.nodes >= state.limits.maxNodes) {
    state.truncated = true;
    return evaluateLeaf(session, ply, state);
  }
  state.nodes += 1;
  const terminal = terminalScore(session.result, state.rootColor, ply);
  if (terminal !== null) {
    return { score: terminal, principalVariation: [] };
  }

  const legalMoves = orderedMoves(session.legalMoves());
  if (depth <= 0 || state.nodes >= state.limits.maxNodes) {
    if (state.nodes >= state.limits.maxNodes) {
      state.truncated = true;
    }
    return evaluateLeaf(session, ply, state, legalMoves);
  }

  const maximizing = session.turn === state.rootColor;
  let bestScore = maximizing ? -INFINITY : INFINITY;
  let bestLine: readonly ChessMove[] = [];
  let alpha = alphaInput;
  let beta = betaInput;
  for (const move of legalMoves) {
    const child = session.fork();
    applySearchMove(child, move);
    const result = await searchNode(
      child,
      depth - 1,
      alpha,
      beta,
      ply + 1,
      state,
    );
    const improves = maximizing
      ? result.score > bestScore
      : result.score < bestScore;
    if (
      improves
      || (
        result.score === bestScore
        && (
          bestLine[0] === undefined
          || moveId(move).localeCompare(moveId(bestLine[0])) < 0
        )
      )
    ) {
      bestScore = result.score;
      bestLine = [move, ...result.principalVariation];
    }
    if (maximizing) {
      alpha = Math.max(alpha, bestScore);
    } else {
      beta = Math.min(beta, bestScore);
    }
    if (beta <= alpha || state.nodes >= state.limits.maxNodes) {
      if (state.nodes >= state.limits.maxNodes) {
        state.truncated = true;
      }
      break;
    }
  }
  return { score: bestScore, principalVariation: bestLine };
}

async function evaluateLeaf(
  session: OmniscientSession,
  ply: number,
  state: SearchState,
  suppliedLegalMoves?: readonly ChessMove[],
): Promise<NodeResult> {
  const legalMoves = suppliedLegalMoves ?? orderedMoves(session.legalMoves());
  const immediateKingCapture = legalMoves.find(
    (move) => move.captured === "king",
  );
  if (immediateKingCapture !== undefined) {
    const score =
      session.turn === state.rootColor
        ? TERMINAL_SCORE - ply - 1
        : -TERMINAL_SCORE + ply + 1;
    return {
      score,
      principalVariation: [immediateKingCapture],
    };
  }
  state.leaves += 1;
  const publicPosition = session.publicPositionSnapshot();
  const sideToMoveScore = await state.evaluator.evaluate(
    {
      authorityId: "capturable-king/v1",
      fen: session.fen,
      turn: session.turn,
      legalMoves,
      history: session.history(),
      orthodoxCompatible: session.orthodoxCompatible,
      kingPassantActive: publicPosition.kingPassant !== null,
    },
    state.limits.signal,
  );
  if (!Number.isFinite(sideToMoveScore)) {
    throw new Error(
      `${state.evaluator.id} returned a non-finite leaf score.`,
    );
  }
  return {
    score:
      session.turn === state.rootColor
        ? sideToMoveScore
        : -sideToMoveScore,
    principalVariation: [],
  };
}

function applySearchMove(
  session: OmniscientSession,
  move: ChessMove,
): void {
  const command: MoveCommand = {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
  const outcome = session.move(command);
  if (!outcome.ok) {
    throw new Error(
      `Search generated a rejected move (${outcome.reason}): ${outcome.message}`,
    );
  }
}

function terminalScore(
  result: SessionResult,
  rootColor: PlayerColor,
  ply: number,
): number | null {
  switch (result.kind) {
    case "active":
      return null;
    case "draw":
      return 0;
    case "drawback-loss": {
      const winner = opposite(result.loss.color);
      return winner === rootColor
        ? TERMINAL_SCORE - ply
        : -TERMINAL_SCORE + ply;
    }
    case "king-capture":
    case "checkmate":
    case "no-legal-moves":
      return result.winner === rootColor
        ? TERMINAL_SCORE - ply
        : -TERMINAL_SCORE + ply;
  }
}

function orderedMoves(moves: readonly ChessMove[]): readonly ChessMove[] {
  return [...moves].sort((left, right) => {
    const captureDelta =
      (right.captured === undefined ? 0 : CAPTURE_VALUE[right.captured])
      - (left.captured === undefined ? 0 : CAPTURE_VALUE[left.captured]);
    return captureDelta !== 0
      ? captureDelta
      : moveId(left).localeCompare(moveId(right));
  });
}

function moveId(move: Pick<ChessMove, "from" | "to" | "promotion">): string {
  return `${move.from}${move.to}${move.promotion?.[0] ?? ""}`;
}

function sameMove(
  left: Pick<ChessMove, "from" | "to" | "promotion">,
  right: Pick<ChessMove, "from" | "to" | "promotion">,
): boolean {
  return (
    left.from === right.from
    && left.to === right.to
    && left.promotion === right.promotion
  );
}

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function validateLimits(limits: DrawbackSearchLimits): void {
  if (!Number.isSafeInteger(limits.depth) || limits.depth <= 0) {
    throw new RangeError("Drawback search depth must be a positive integer.");
  }
  if (!Number.isSafeInteger(limits.maxNodes) || limits.maxNodes <= 1) {
    throw new RangeError(
      "Drawback search maxNodes must be an integer greater than one.",
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("Drawback search was aborted.", "AbortError");
  }
}
