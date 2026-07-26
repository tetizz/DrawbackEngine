import {
  CapturableKingPosition,
  inspectPublicGameTrace,
  type CapturableKingPositionSnapshot,
  type MoveCommand,
  type PublicGameTrace,
} from "@drawbackengine/chess-core";
import type {
  ChessMove,
  PositionView,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";
import type {
  OwnPlayerRuleCapability,
  PublicDrawbackHypothesis,
} from "./player-private-capability.js";
import {
  assertOwnPlayerCapability,
  assertPublicHypothesisCapability,
} from "./player-private-capability.js";
import type {
  DrawbackLeafEvaluator,
  DrawbackSearchLimits,
} from "./types.js";

const TERMINAL_SCORE = 1_000_000;
const INFINITY = TERMINAL_SCORE + 100_000;
const AUTHORITY_ID = "capturable-king/v1";

const CAPTURE_VALUE: Readonly<
  Record<NonNullable<ChessMove["captured"]>, number>
> = {
  pawn: 100,
  knight: 320,
  bishop: 330,
  rook: 500,
  queen: 900,
  king: TERMINAL_SCORE,
};

export interface PlayerPrivateSearchInput {
  readonly trace: PublicGameTrace;
  readonly own: OwnPlayerRuleCapability;
  readonly opponent: readonly PublicDrawbackHypothesis[];
  readonly aggregation: "worst-case";
  readonly evaluator: DrawbackLeafEvaluator;
  readonly limits: DrawbackSearchLimits;
}

export interface PlayerPrivateSearchResult {
  readonly move: ChessMove;
  /** Centipawns from the root player's perspective. */
  readonly score: number;
  readonly principalVariation: readonly ChessMove[];
  readonly nodes: number;
  readonly leaves: number;
  readonly truncated: boolean;
  readonly rootColor: PlayerColor;
  readonly evaluatorId: string;
  readonly knowledgeMode: "player-private";
  readonly aggregation: "worst-case";
  readonly opponentHypothesisCount: number;
}

export interface PlayerPrivateRootMoveSearchResult
  extends PlayerPrivateSearchResult {
  /** Fully searched outer depth for this exact root. */
  readonly depth: number;
}

interface PrivateNode {
  readonly position: CapturableKingPosition;
  readonly history: readonly ChessMove[];
  readonly own: OwnPlayerRuleCapability;
  readonly opponent: readonly PublicDrawbackHypothesis[];
}

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

interface MoveBranch {
  readonly move: ChessMove;
  readonly node: PrivateNode;
}

interface TurnExpansion {
  readonly terminalScore: number | null;
  readonly moves: readonly ChessMove[];
}

interface PreparedSearchRoot {
  readonly root: PrivateNode;
  readonly rootColor: PlayerColor;
  readonly moves: readonly ChessMove[];
}

export async function searchPlayerPrivateDrawbackMove(
  input: PlayerPrivateSearchInput,
): Promise<PlayerPrivateSearchResult> {
  const prepared = prepareSearchRoot(input);
  const state: SearchState = {
    rootColor: prepared.rootColor,
    evaluator: input.evaluator,
    limits: input.limits,
    nodes: 1,
    leaves: 0,
    truncated: false,
  };
  let bestMove: ChessMove | null = null;
  let bestScore = -INFINITY;
  let bestLine: readonly ChessMove[] = [];
  let alpha = -INFINITY;
  for (const move of orderedMoves(prepared.moves)) {
    throwIfAborted(input.limits.signal);
    if (bestMove !== null && state.nodes >= input.limits.maxNodes) {
      state.truncated = true;
      break;
    }
    const branch = applyOwnMove(prepared.root, move);
    const result = await searchNode(
      branch,
      input.limits.depth - 1,
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
    throw new Error("Player-private search failed to select a move.");
  }
  return Object.freeze({
    move: structuredClone(bestMove),
    score: bestScore,
    principalVariation: Object.freeze(structuredClone(bestLine)),
    nodes: state.nodes,
    leaves: state.leaves,
    truncated: state.truncated,
    rootColor: prepared.rootColor,
    evaluatorId: input.evaluator.id,
    knowledgeMode: "player-private",
    aggregation: "worst-case",
    opponentHypothesisCount: input.opponent.length,
  });
}

/**
 * Scores one exact player-private root with a full alpha-beta window.
 *
 * The input retains the same branded own-rule and public-hypothesis
 * capabilities as the multi-root search. No authoritative opponent runtime or
 * secret state is accepted.
 */
export async function searchPlayerPrivateDrawbackRootMove(
  input: PlayerPrivateSearchInput,
  rootMove: Pick<ChessMove, "from" | "to" | "promotion">,
): Promise<PlayerPrivateRootMoveSearchResult> {
  const prepared = prepareSearchRoot(input);
  const move = prepared.moves.find((candidate) =>
    sameMove(candidate, rootMove)
  );
  if (move === undefined) {
    throw new RangeError(
      `Root move ${moveId(rootMove)} is not legal under the player's drawback.`,
    );
  }
  const state: SearchState = {
    rootColor: prepared.rootColor,
    evaluator: input.evaluator,
    limits: input.limits,
    nodes: 1,
    leaves: 0,
    truncated: false,
  };
  const branch = applyOwnMove(prepared.root, move);
  const result = await searchNode(
    branch,
    input.limits.depth - 1,
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
    rootColor: prepared.rootColor,
    evaluatorId: input.evaluator.id,
    knowledgeMode: "player-private",
    aggregation: "worst-case",
    opponentHypothesisCount: input.opponent.length,
    depth: input.limits.depth,
  });
}

/**
 * Internal candidate discovery for complete-root iterative search.
 *
 * This returns only exact own-rule legal moves and preserves the same
 * capability validation as the public search entry points.
 */
export function playerPrivateDrawbackRootMoves(
  input: PlayerPrivateSearchInput,
): readonly ChessMove[] {
  return Object.freeze(
    structuredClone(orderedMoves(prepareSearchRoot(input).moves)),
  );
}

function prepareSearchRoot(
  input: PlayerPrivateSearchInput,
): PreparedSearchRoot {
  validateInput(input);
  throwIfAborted(input.limits.signal);
  const traced = inspectPublicGameTrace(input.trace);
  if (traced.current.authorityId !== AUTHORITY_ID) {
    throw new Error("Player-private search requires capturable-king/v1.");
  }
  const rootPosition = CapturableKingPosition.fromSnapshot(traced.current);
  const rootColor = rootPosition.turn;
  const root: PrivateNode = {
    position: rootPosition,
    history: structuredClone(traced.moves),
    own: input.own.fork(),
    opponent: normalizeHypotheses(input.opponent),
  };
  const expansion = expandTurn(root, rootColor, 0);
  if (expansion.terminalScore !== null) {
    throw new Error("Cannot search a terminal player-private position.");
  }
  if (expansion.moves.length === 0) {
    throw new Error("Active player-private position has no legal moves.");
  }
  return {
    root,
    rootColor,
    moves: expansion.moves,
  };
}

async function searchNode(
  node: PrivateNode,
  depth: number,
  alphaInput: number,
  betaInput: number,
  ply: number,
  state: SearchState,
): Promise<NodeResult> {
  throwIfAborted(state.limits.signal);
  if (state.nodes >= state.limits.maxNodes) {
    state.truncated = true;
    return evaluateLeaf(node, ply, state);
  }
  state.nodes += 1;
  const expansion = expandTurn(node, state.rootColor, ply);
  if (expansion.terminalScore !== null) {
    return { score: expansion.terminalScore, principalVariation: [] };
  }
  if (depth <= 0 || state.nodes >= state.limits.maxNodes) {
    if (state.nodes >= state.limits.maxNodes) {
      state.truncated = true;
    }
    return evaluateLeaf(node, ply, state, expansion.moves);
  }

  const ownTurn = node.position.turn === state.rootColor;
  let bestScore = ownTurn ? -INFINITY : INFINITY;
  let bestLine: readonly ChessMove[] = [];
  let alpha = alphaInput;
  let beta = betaInput;
  const branches = ownTurn
    ? orderedMoves(expansion.moves).map((move) => ({
        move,
        node: applyOwnMove(node, move),
      }))
    : opponentBranches(node, expansion.moves);
  for (const branch of branches) {
    const result = await searchNode(
      branch.node,
      depth - 1,
      alpha,
      beta,
      ply + 1,
      state,
    );
    const improves = ownTurn
      ? result.score > bestScore
      : result.score < bestScore;
    if (
      improves
      || (
        result.score === bestScore
        && (
          bestLine[0] === undefined
          || moveId(branch.move).localeCompare(moveId(bestLine[0])) < 0
        )
      )
    ) {
      bestScore = result.score;
      bestLine = [branch.move, ...result.principalVariation];
    }
    if (ownTurn) {
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

function expandTurn(
  node: PrivateNode,
  rootColor: PlayerColor,
  ply: number,
): TurnExpansion {
  const terminal = node.position.snapshot().terminal;
  if (terminal !== null) {
    return {
      terminalScore:
        terminal.winner === rootColor
          ? TERMINAL_SCORE - ply
          : -TERMINAL_SCORE + ply,
      moves: [],
    };
  }
  const authorityMoves = node.position.legalMoves();
  if (authorityMoves.length === 0) {
    return {
      terminalScore:
        node.position.turn === rootColor
          ? -TERMINAL_SCORE + ply
          : TERMINAL_SCORE - ply,
      moves: [],
    };
  }
  const view = positionView(node);
  if (node.position.turn === rootColor) {
    if (node.own.checkStartOfTurnLoss(view) !== null) {
      return {
        terminalScore: -TERMINAL_SCORE + ply,
        moves: [],
      };
    }
    const legalMoves = node.own.legalMoves(view, authorityMoves);
    return legalMoves.length === 0
      ? {
          terminalScore: -TERMINAL_SCORE + ply,
          moves: [],
        }
      : { terminalScore: null, moves: legalMoves };
  }

  const liveMoves: ChessMove[] = [];
  for (const hypothesis of node.opponent) {
    if (hypothesis.capability.checkStartOfTurnLoss(view) !== null) {
      continue;
    }
    for (const move of hypothesis.capability.legalMoves(view, authorityMoves)) {
      if (!liveMoves.some((candidate) => sameMove(candidate, move))) {
        liveMoves.push(move);
      }
    }
  }
  return liveMoves.length === 0
    ? {
        terminalScore: TERMINAL_SCORE - ply,
        moves: [],
      }
    : {
        terminalScore: null,
        moves: orderedMoves(liveMoves),
      };
}

function applyOwnMove(node: PrivateNode, move: ChessMove): PrivateNode {
  const before = positionView(node);
  const position = node.position.clone();
  applyAuthorityMove(position, move);
  const history = Object.freeze([...node.history, structuredClone(move)]);
  return {
    position,
    history,
    own: node.own.applyMove(before, positionView({ ...node, position, history }), move),
    opponent: node.opponent.map((hypothesis) => ({
      ...hypothesis,
      capability: hypothesis.capability.applyMove(
        before,
        positionView({ ...node, position, history }),
        move,
      ),
    })),
  };
}

function opponentBranches(
  node: PrivateNode,
  moves: readonly ChessMove[],
): readonly MoveBranch[] {
  const before = positionView(node);
  const authorityMoves = node.position.legalMoves();
  return orderedMoves(moves).map((move) => {
    const position = node.position.clone();
    applyAuthorityMove(position, move);
    const history = Object.freeze([...node.history, structuredClone(move)]);
    const after = positionView({ ...node, position, history });
    const compatible: PublicDrawbackHypothesis[] = [];
    for (const hypothesis of node.opponent) {
      if (hypothesis.capability.checkStartOfTurnLoss(before) !== null) {
        continue;
      }
      const legalMoves = hypothesis.capability.legalMoves(
        before,
        authorityMoves,
      );
      if (!legalMoves.some((candidate) => sameMove(candidate, move))) {
        continue;
      }
      compatible.push({
        hypothesisId: hypothesis.hypothesisId,
        probability: hypothesis.probability,
        capability: hypothesis.capability.applyMove(before, after, move),
      });
    }
    if (compatible.length === 0) {
      throw new Error(
        `No public opponent hypothesis permits ${moveId(move)}.`,
      );
    }
    return {
      move,
      node: {
        position,
        history,
        own: node.own.applyMove(before, after, move),
        opponent: normalizeHypotheses(compatible),
      },
    };
  });
}

async function evaluateLeaf(
  node: PrivateNode,
  ply: number,
  state: SearchState,
  suppliedMoves?: readonly ChessMove[],
): Promise<NodeResult> {
  const expansion =
    suppliedMoves === undefined
      ? expandTurn(node, state.rootColor, ply)
      : { terminalScore: null, moves: suppliedMoves };
  if (expansion.terminalScore !== null) {
    return { score: expansion.terminalScore, principalVariation: [] };
  }
  const immediateKingCapture = expansion.moves.find(
    (move) => move.captured === "king",
  );
  if (immediateKingCapture !== undefined) {
    return {
      score:
        node.position.turn === state.rootColor
          ? TERMINAL_SCORE - ply - 1
          : -TERMINAL_SCORE + ply + 1,
      principalVariation: [immediateKingCapture],
    };
  }
  state.leaves += 1;
  const publicPosition = node.position.snapshot();
  const score = await state.evaluator.evaluate(
    {
      authorityId: "capturable-king/v1",
      fen: node.position.fen,
      turn: node.position.turn,
      legalMoves: expansion.moves,
      history: node.history,
      orthodoxCompatible: node.position.orthodoxCompatible,
      kingPassantActive: publicPosition.kingPassant !== null,
    },
    state.limits.signal,
  );
  if (!Number.isFinite(score)) {
    throw new Error(`${state.evaluator.id} returned a non-finite leaf score.`);
  }
  return {
    score: node.position.turn === state.rootColor ? score : -score,
    principalVariation: [],
  };
}

function normalizeHypotheses(
  hypotheses: readonly PublicDrawbackHypothesis[],
): readonly PublicDrawbackHypothesis[] {
  const total = hypotheses.reduce(
    (sum, hypothesis) => sum + hypothesis.probability,
    0,
  );
  if (!Number.isFinite(total) || total <= 0) {
    throw new RangeError(
      "Opponent hypothesis probabilities must have positive finite mass.",
    );
  }
  return Object.freeze(
    hypotheses.map((hypothesis) =>
      Object.freeze({
        hypothesisId: hypothesis.hypothesisId,
        probability: hypothesis.probability / total,
        capability: hypothesis.capability.fork(),
      }),
    ),
  );
}

function positionView(node: PrivateNode): PositionView {
  return {
    fen: node.position.fen,
    turn: node.position.turn,
    ply: node.history.length,
    history: node.history,
  };
}

function applyAuthorityMove(
  position: CapturableKingPosition,
  move: ChessMove,
): void {
  const command: MoveCommand = {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
  if (position.move(command) === null) {
    throw new Error(`Position authority rejected ${moveId(move)}.`);
  }
}

function validateInput(input: PlayerPrivateSearchInput): void {
  const traced = inspectPublicGameTrace(input.trace);
  if (traced.current.authorityId !== AUTHORITY_ID) {
    throw new Error("Player-private search requires capturable-king/v1.");
  }
  const snapshot: CapturableKingPositionSnapshot = traced.current;
  if (snapshot.terminal !== null) {
    throw new Error("Cannot search a completed public position.");
  }
  if (input.own.authorityId !== AUTHORITY_ID) {
    throw new Error("Own rule capability uses the wrong position authority.");
  }
  const position = CapturableKingPosition.fromSnapshot(snapshot);
  const currentPosition: PositionView = {
    fen: position.fen,
    turn: position.turn,
    ply: traced.moves.length,
    history: structuredClone(traced.moves),
  };
  assertOwnPlayerCapability(input.own, currentPosition);
  if (input.own.color !== position.turn) {
    throw new Error("Own rule capability color must be the side to move.");
  }
  if (input.opponent.length === 0) {
    throw new RangeError(
      "Player-private search requires at least one opponent hypothesis.",
    );
  }
  const opponentColor = opposite(position.turn);
  const ids = new Set<string>();
  for (const hypothesis of input.opponent) {
    if (ids.has(hypothesis.hypothesisId)) {
      throw new RangeError(
        `Duplicate opponent hypothesis: ${hypothesis.hypothesisId}`,
      );
    }
    ids.add(hypothesis.hypothesisId);
    if (hypothesis.capability.authorityId !== AUTHORITY_ID) {
      throw new Error(
        `${hypothesis.hypothesisId} uses the wrong position authority.`,
      );
    }
    if (hypothesis.capability.color !== opponentColor) {
      throw new Error(
        `${hypothesis.hypothesisId} has the wrong opponent color.`,
      );
    }
    assertPublicHypothesisCapability(
      hypothesis.capability,
      currentPosition,
    );
    if (
      !Number.isFinite(hypothesis.probability)
      || hypothesis.probability <= 0
    ) {
      throw new RangeError(
        `${hypothesis.hypothesisId} has invalid probability mass.`,
      );
    }
  }
  validateLimits(input.limits);
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

function moveId(
  move: Pick<ChessMove, "from" | "to" | "promotion">,
): string {
  return `${move.from}${move.to}${move.promotion?.[0] ?? ""}`;
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
