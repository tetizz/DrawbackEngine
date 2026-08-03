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

export type PlayerPrivateOpponentAggregation =
  | "worst-case"
  | "posterior-expected"
  | "posterior-cvar-25";

const PLAYER_PRIVATE_AGGREGATIONS: ReadonlySet<string> = new Set([
  "worst-case",
  "posterior-expected",
  "posterior-cvar-25",
]);
const POSTERIOR_CVAR_TAIL_MASS = 0.25;

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
  readonly aggregation: PlayerPrivateOpponentAggregation;
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
  readonly aggregation: PlayerPrivateOpponentAggregation;
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
  readonly aggregation: PlayerPrivateOpponentAggregation;
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
  readonly opponentWorlds?: readonly OpponentWorldExpansion[];
}

interface OpponentWorldExpansion {
  readonly hypothesisId: string;
  readonly probability: number;
  readonly terminalScore: number | null;
  readonly legalMoveIds: readonly string[];
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
    aggregation: input.aggregation,
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
    aggregation: input.aggregation,
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
    aggregation: input.aggregation,
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
    aggregation: input.aggregation,
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
    return evaluateLeaf(node, ply, state, expansion);
  }

  const ownTurn = node.position.turn === state.rootColor;
  if (
    !ownTurn
    && state.aggregation !== "worst-case"
  ) {
    return searchPosteriorOpponentNode(
      node,
      expansion,
      depth,
      ply,
      state,
    );
  }
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
  const opponentWorlds: OpponentWorldExpansion[] = [];
  for (const hypothesis of node.opponent) {
    if (hypothesis.capability.checkStartOfTurnLoss(view) !== null) {
      opponentWorlds.push({
        hypothesisId: hypothesis.hypothesisId,
        probability: hypothesis.probability,
        terminalScore: TERMINAL_SCORE - ply,
        legalMoveIds: [],
      });
      continue;
    }
    const legalMoves = hypothesis.capability.legalMoves(view, authorityMoves);
    if (legalMoves.length === 0) {
      opponentWorlds.push({
        hypothesisId: hypothesis.hypothesisId,
        probability: hypothesis.probability,
        terminalScore: TERMINAL_SCORE - ply,
        legalMoveIds: [],
      });
      continue;
    }
    opponentWorlds.push({
      hypothesisId: hypothesis.hypothesisId,
      probability: hypothesis.probability,
      terminalScore: null,
      legalMoveIds: Object.freeze(legalMoves.map(moveId)),
    });
    for (const move of legalMoves) {
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
        opponentWorlds: Object.freeze(opponentWorlds),
      };
}

/**
 * Computes posterior-risk search at an opponent node.
 *
 * Each hypothesis is a possible private-rule world. In that world the
 * opponent knows its rule and chooses its lowest-valued legal reply. The
 * selected policy combines those world-specific minima by posterior
 * expectation or lower-tail CVaR. Each reply branch is searched once and
 * conditions its child posterior by exact legality, so contradicted worlds
 * never reappear.
 *
 * Posterior-risk nodes deliberately use full child windows: ordinary
 * alpha-beta bounds are unsound across weighted or lower-tail combinations
 * of independently minimizing worlds.
 */
async function searchPosteriorOpponentNode(
  node: PrivateNode,
  expansion: TurnExpansion,
  depth: number,
  ply: number,
  state: SearchState,
): Promise<NodeResult> {
  const worlds = requiredOpponentWorlds(expansion);
  const branches = opponentBranches(node, expansion.moves);
  const evaluated = new Map<string, EvaluatedMoveBranch>();
  for (const branch of branches) {
    const result = await searchNode(
      branch.node,
      depth - 1,
      -INFINITY,
      INFINITY,
      ply + 1,
      state,
    );
    evaluated.set(moveId(branch.move), { branch, result });
  }

  const outcomes: WorldScoreOutcome[] = [];
  for (const world of worlds) {
    if (world.terminalScore !== null) {
      outcomes.push({
        hypothesisId: world.hypothesisId,
        probability: world.probability,
        score: world.terminalScore,
        replyId: null,
      });
      continue;
    }
    const selected = minimumWorldReply(world, evaluated);
    outcomes.push({
      hypothesisId: world.hypothesisId,
      probability: world.probability,
      score: selected.result.score,
      replyId: moveId(selected.branch.move),
    });
  }
  const aggregation = aggregateWorldOutcomes(state.aggregation, outcomes);
  const representative = representativePosteriorReply(
    aggregation.representativeMass,
    evaluated,
  );
  return {
    score: aggregation.score,
    principalVariation:
      representative === null
        ? []
        : [
            representative.branch.move,
            ...representative.result.principalVariation,
          ],
  };
}

interface EvaluatedMoveBranch {
  readonly branch: MoveBranch;
  readonly result: NodeResult;
}

interface WorldScoreOutcome {
  readonly hypothesisId: string;
  readonly probability: number;
  readonly score: number;
  readonly replyId: string | null;
}

interface AggregatedWorldOutcomes {
  readonly score: number;
  readonly representativeMass: ReadonlyMap<string, number>;
}

function aggregateWorldOutcomes(
  aggregation: PlayerPrivateOpponentAggregation,
  outcomes: readonly WorldScoreOutcome[],
): AggregatedWorldOutcomes {
  const representativeMass = new Map<string, number>();
  if (aggregation === "worst-case") {
    throw new Error(
      "Worst-case search cannot use posterior world aggregation.",
    );
  }
  if (aggregation === "posterior-expected") {
    let score = 0;
    for (const outcome of outcomes) {
      score += outcome.probability * outcome.score;
      addRepresentativeMass(
        representativeMass,
        outcome.replyId,
        outcome.probability,
      );
    }
    return { score, representativeMass };
  }

  const ordered = [...outcomes].sort(
    (left, right) =>
      left.score - right.score
      || left.hypothesisId.localeCompare(right.hypothesisId),
  );
  let remaining = POSTERIOR_CVAR_TAIL_MASS;
  let includedMass = 0;
  let weightedScore = 0;
  let representativeScore: number | null = null;
  for (const outcome of ordered) {
    if (remaining <= Number.EPSILON) {
      break;
    }
    const mass = Math.min(outcome.probability, remaining);
    weightedScore += mass * outcome.score;
    includedMass += mass;
    remaining -= mass;
    if (outcome.replyId !== null) {
      if (
        representativeScore === null
        || outcome.score < representativeScore
      ) {
        representativeMass.clear();
        representativeScore = outcome.score;
      }
      if (outcome.score === representativeScore) {
        addRepresentativeMass(representativeMass, outcome.replyId, mass);
      }
    }
  }
  if (
    includedMass <= 0
    || includedMass + Number.EPSILON < POSTERIOR_CVAR_TAIL_MASS
  ) {
    throw new Error(
      "Posterior CVaR requires normalized positive hypothesis mass.",
    );
  }
  return {
    score: weightedScore / includedMass,
    representativeMass,
  };
}

function addRepresentativeMass(
  mass: Map<string, number>,
  replyId: string | null,
  probability: number,
): void {
  if (replyId === null) {
    return;
  }
  mass.set(replyId, (mass.get(replyId) ?? 0) + probability);
}

function minimumWorldReply(
  world: OpponentWorldExpansion,
  evaluated: ReadonlyMap<string, EvaluatedMoveBranch>,
): EvaluatedMoveBranch {
  let selected: EvaluatedMoveBranch | null = null;
  for (const id of [...world.legalMoveIds].sort()) {
    const candidate = evaluated.get(id);
    if (candidate === undefined) {
      throw new Error(
        `${world.hypothesisId} permits missing opponent branch ${id}.`,
      );
    }
    if (
      selected === null
      || candidate.result.score < selected.result.score
      || (
        candidate.result.score === selected.result.score
        && id.localeCompare(moveId(selected.branch.move)) < 0
      )
    ) {
      selected = candidate;
    }
  }
  if (selected === null) {
    throw new Error(
      `${world.hypothesisId} has no legal reply or terminal result.`,
    );
  }
  return selected;
}

function representativePosteriorReply(
  mass: ReadonlyMap<string, number>,
  evaluated: ReadonlyMap<string, EvaluatedMoveBranch>,
): EvaluatedMoveBranch | null {
  const selectedId = [...mass.entries()].sort(
    ([leftId, leftMass], [rightId, rightMass]) =>
      rightMass - leftMass || leftId.localeCompare(rightId),
  )[0]?.[0];
  if (selectedId === undefined) {
    return null;
  }
  const selected = evaluated.get(selectedId);
  if (selected === undefined) {
    throw new Error(`Representative opponent branch ${selectedId} is missing.`);
  }
  return selected;
}

function requiredOpponentWorlds(
  expansion: TurnExpansion,
): readonly OpponentWorldExpansion[] {
  if (expansion.opponentWorlds === undefined) {
    throw new Error(
      "Posterior-risk opponent search requires world expansions.",
    );
  }
  return expansion.opponentWorlds;
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

/**
 * Extends one optional horizon ply through exact captures, then follows
 * mandatory capture-only continuations. Posterior modes retain each world's
 * legal mask, so one world's quiet reply cannot stand in for another world's
 * forced capture.
 */
async function evaluateLeaf(
  node: PrivateNode,
  ply: number,
  state: SearchState,
  suppliedExpansion?: TurnExpansion,
  extendOptionalCaptures = true,
): Promise<NodeResult> {
  const expansion =
    suppliedExpansion === undefined
      ? expandTurn(node, state.rootColor, ply)
      : suppliedExpansion;
  if (expansion.terminalScore !== null) {
    return { score: expansion.terminalScore, principalVariation: [] };
  }
  const captures = orderedMoves(
    expansion.moves.filter((move) => move.captured !== undefined),
  );
  if (
    node.position.turn !== state.rootColor
    && state.aggregation !== "worst-case"
  ) {
    if (captures.length === 0) {
      return evaluatePosteriorOpponentLeaf(
        node,
        ply,
        state,
        expansion,
      );
    }
    const forcedCaptures = forcedOpponentCaptures(expansion);
    if (!extendOptionalCaptures && forcedCaptures.length === 0) {
      return evaluatePosteriorOpponentLeaf(
        node,
        ply,
        state,
        expansion,
      );
    }
    if (state.nodes + captures.length > state.limits.maxNodes) {
      state.truncated = true;
      return evaluatePosteriorOpponentBudgetFallback(
        node,
        ply,
        state,
        expansion,
      );
    }
    return evaluatePosteriorOpponentCaptureExtension(
      node,
      ply,
      state,
      expansion,
      captures,
    );
  }
  const baseline = await evaluateLeafBaseline(node, ply, state, expansion);
  if (
    captures.length === 0
    || captures.some((move) => move.captured === "king")
  ) {
    return baseline;
  }
  const ownTurn = node.position.turn === state.rootColor;
  const forcedCaptures = ownTurn ? [] : forcedOpponentCaptures(expansion);
  const quietMoveAvailable = expansion.moves.some(
    (move) => move.captured === undefined,
  );
  if (
    !extendOptionalCaptures
    && quietMoveAvailable
    && forcedCaptures.length === 0
  ) {
    return baseline;
  }
  if (state.nodes + captures.length > state.limits.maxNodes) {
    state.truncated = true;
    return forcedCaptures.length > 0
      ? conservativeForcedCaptureResult(forcedCaptures, ply)
      : quietMoveAvailable
        ? baseline
        : conservativeForcedCaptureResult(captures, ply);
  }

  const branches = ownTurn
    ? captures.map((move) => ({ move, node: applyOwnMove(node, move) }))
    : opponentBranches(node, captures);
  let selected: NodeResult | null = quietMoveAvailable ? baseline : null;
  for (const branch of branches) {
    if (state.nodes >= state.limits.maxNodes) {
      state.truncated = true;
      return forcedCaptures.length > 0
        ? conservativeForcedCaptureResult(forcedCaptures, ply)
        : quietMoveAvailable
          ? baseline
          : conservativeForcedCaptureResult(captures, ply);
    }
    state.nodes += 1;
    const child = await evaluateLeaf(
      branch.node,
      ply + 1,
      state,
      undefined,
      false,
    );
    const candidate: NodeResult = {
      score: child.score,
      principalVariation: [branch.move, ...child.principalVariation],
    };
    if (
      selected === null
      || improvesTacticalResult(candidate, selected, ownTurn)
    ) {
      selected = candidate;
    }
  }
  if (selected === null) {
    throw new Error("Capture extension produced no selectable continuation.");
  }
  return selected;
}

async function evaluateLeafBaseline(
  node: PrivateNode,
  ply: number,
  state: SearchState,
  suppliedExpansion?: TurnExpansion,
): Promise<NodeResult> {
  const expansion =
    suppliedExpansion === undefined
      ? expandTurn(node, state.rootColor, ply)
      : suppliedExpansion;
  if (expansion.terminalScore !== null) {
    return { score: expansion.terminalScore, principalVariation: [] };
  }
  if (
    node.position.turn !== state.rootColor
    && state.aggregation !== "worst-case"
  ) {
    return evaluatePosteriorOpponentLeaf(
      node,
      ply,
      state,
      expansion,
    );
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
  return {
    score: await evaluateStaticLeaf(node, state, expansion.moves),
    principalVariation: [],
  };
}

/**
 * Extends a posterior opponent horizon through every distinct legal capture.
 * Each hidden-rule world may still stand pat only when it has a quiet legal
 * reply; forced-capture worlds must select one of their exact capture branches.
 */
async function evaluatePosteriorOpponentCaptureExtension(
  node: PrivateNode,
  ply: number,
  state: SearchState,
  expansion: TurnExpansion,
  captures: readonly ChessMove[],
): Promise<NodeResult> {
  const evaluated = new Map<string, EvaluatedMoveBranch>();
  for (const branch of opponentBranches(node, captures)) {
    if (state.nodes >= state.limits.maxNodes) {
      state.truncated = true;
      return evaluatePosteriorOpponentBudgetFallback(
        node,
        ply,
        state,
        expansion,
      );
    }
    state.nodes += 1;
    const result = await evaluateLeaf(
      branch.node,
      ply + 1,
      state,
      undefined,
      false,
    );
    if (state.truncated) {
      return evaluatePosteriorOpponentBudgetFallback(
        node,
        ply,
        state,
        expansion,
      );
    }
    evaluated.set(moveId(branch.move), { branch, result });
  }

  const movesById = new Map(
    expansion.moves.map((move) => [moveId(move), move] as const),
  );
  const staticScores = new Map<string, number>();
  const outcomes: WorldScoreOutcome[] = [];
  for (const world of requiredOpponentWorlds(expansion)) {
    if (world.terminalScore !== null) {
      outcomes.push({
        hypothesisId: world.hypothesisId,
        probability: world.probability,
        score: world.terminalScore,
        replyId: null,
      });
      continue;
    }
    const legalMoveIds = [...world.legalMoveIds].sort();
    const captureIds = legalMoveIds.filter(
      (id) => movesById.get(id)?.captured !== undefined,
    );
    const quietMoveAvailable = legalMoveIds.some(
      (id) => movesById.get(id)?.captured === undefined,
    );
    let selected: { readonly score: number; readonly replyId: string | null }
      | null = null;
    if (quietMoveAvailable || captureIds.length === 0) {
      const maskId = legalMoveIds.join(",");
      let staticScore = staticScores.get(maskId);
      if (staticScore === undefined) {
        staticScore = await evaluateStaticLeaf(
          node,
          state,
          movesForWorld(world, movesById),
        );
        staticScores.set(maskId, staticScore);
      }
      selected = { score: staticScore, replyId: null };
    }
    for (const id of captureIds) {
      const candidate = evaluated.get(id);
      if (candidate === undefined) {
        throw new Error(
          `${world.hypothesisId} permits missing capture branch ${id}.`,
        );
      }
      if (
        selected === null
        || candidate.result.score < selected.score
        || (
          candidate.result.score === selected.score
          && selected.replyId !== null
          && id.localeCompare(selected.replyId) < 0
        )
      ) {
        selected = { score: candidate.result.score, replyId: id };
      }
    }
    if (selected === null) {
      throw new Error(
        `${world.hypothesisId} has no tactical leaf continuation.`,
      );
    }
    outcomes.push({
      hypothesisId: world.hypothesisId,
      probability: world.probability,
      score: selected.score,
      replyId: selected.replyId,
    });
  }
  const aggregation = aggregateWorldOutcomes(state.aggregation, outcomes);
  const representative = representativePosteriorReply(
    aggregation.representativeMass,
    evaluated,
  );
  return {
    score: aggregation.score,
    principalVariation:
      representative === null
        ? []
        : [
            representative.branch.move,
            ...representative.result.principalVariation,
          ],
  };
}

/**
 * Produces a fail-closed posterior score when the hard node cap prevents an
 * exact capture child. Worlds with a quiet legal reply may retain their static
 * leaf; forced-capture worlds receive a root-loss bound and a legal reply PV.
 * No uncharged child position is evaluated.
 */
async function evaluatePosteriorOpponentBudgetFallback(
  node: PrivateNode,
  ply: number,
  state: SearchState,
  expansion: TurnExpansion,
): Promise<NodeResult> {
  const movesById = new Map(
    expansion.moves.map((move) => [moveId(move), move] as const),
  );
  const staticScores = new Map<string, number>();
  const outcomes: WorldScoreOutcome[] = [];
  for (const world of requiredOpponentWorlds(expansion)) {
    if (world.terminalScore !== null) {
      outcomes.push({
        hypothesisId: world.hypothesisId,
        probability: world.probability,
        score: world.terminalScore,
        replyId: null,
      });
      continue;
    }
    const moves = movesForWorld(world, movesById);
    const captures = orderedMoves(
      moves.filter((move) => move.captured !== undefined),
    );
    const kingCapture = captures.find((move) => move.captured === "king");
    if (kingCapture !== undefined) {
      outcomes.push({
        hypothesisId: world.hypothesisId,
        probability: world.probability,
        score: -TERMINAL_SCORE + ply + 1,
        replyId: moveId(kingCapture),
      });
      continue;
    }
    const quietMoveAvailable = moves.some(
      (move) => move.captured === undefined,
    );
    if (!quietMoveAvailable && captures.length > 0) {
      const forced = conservativeForcedCaptureResult(captures, ply);
      const forcedMove = forced.principalVariation[0];
      if (forcedMove === undefined) {
        throw new Error("Forced posterior fallback has no legal reply.");
      }
      outcomes.push({
        hypothesisId: world.hypothesisId,
        probability: world.probability,
        score: forced.score,
        replyId: moveId(forcedMove),
      });
      continue;
    }
    const maskId = [...world.legalMoveIds].sort().join(",");
    let staticScore = staticScores.get(maskId);
    if (staticScore === undefined) {
      staticScore = await evaluateStaticLeaf(node, state, moves);
      staticScores.set(maskId, staticScore);
    }
    outcomes.push({
      hypothesisId: world.hypothesisId,
      probability: world.probability,
      score: staticScore,
      replyId: null,
    });
  }
  const aggregation = aggregateWorldOutcomes(state.aggregation, outcomes);
  const selectedId = [...aggregation.representativeMass.entries()].sort(
    ([leftId, leftMass], [rightId, rightMass]) =>
      rightMass - leftMass || leftId.localeCompare(rightId),
  )[0]?.[0];
  const selectedMove =
    selectedId === undefined ? undefined : movesById.get(selectedId);
  if (selectedId !== undefined && selectedMove === undefined) {
    throw new Error(
      `Conservative posterior reply ${selectedId} is missing.`,
    );
  }
  return {
    score: aggregation.score,
    principalVariation: selectedMove === undefined ? [] : [selectedMove],
  };
}

/**
 * Returns captures that are mandatory in at least one live opponent world.
 * The result is ordered and de-duplicated so it can also seed a deterministic
 * conservative PV when the node budget cannot visit those children.
 */
function forcedOpponentCaptures(
  expansion: TurnExpansion,
): readonly ChessMove[] {
  const worlds = requiredOpponentWorlds(expansion);
  const movesById = new Map(
    expansion.moves.map((move) => [moveId(move), move] as const),
  );
  const forced = new Map<string, ChessMove>();
  for (const world of worlds) {
    if (world.terminalScore !== null) {
      continue;
    }
    const moves = movesForWorld(world, movesById);
    const captures = moves.filter((move) => move.captured !== undefined);
    if (
      captures.length > 0
      && captures.length === moves.length
    ) {
      for (const move of captures) {
        forced.set(moveId(move), move);
      }
    }
  }
  return orderedMoves([...forced.values()]);
}

/**
 * A truncated forced-capture leaf cannot use an illegal static stand-pat.
 * This deterministic root-loss bound preserves a legal PV without evaluating
 * an uncharged child; `truncated` records that the score is conservative.
 */
function conservativeForcedCaptureResult(
  captures: readonly ChessMove[],
  ply: number,
): NodeResult {
  const forcedMove = captures[0];
  if (forcedMove === undefined) {
    throw new Error("Forced-capture fallback requires a legal capture.");
  }
  return {
    score: -TERMINAL_SCORE + ply + 1,
    principalVariation: [forcedMove],
  };
}

function improvesTacticalResult(
  candidate: NodeResult,
  selected: NodeResult,
  maximizing: boolean,
): boolean {
  if (candidate.score !== selected.score) {
    return maximizing
      ? candidate.score > selected.score
      : candidate.score < selected.score;
  }
  const candidateMove = candidate.principalVariation[0];
  const selectedMove = selected.principalVariation[0];
  return candidateMove !== undefined
    && selectedMove !== undefined
    && moveId(candidateMove).localeCompare(moveId(selectedMove)) < 0;
}

async function evaluatePosteriorOpponentLeaf(
  node: PrivateNode,
  ply: number,
  state: SearchState,
  expansion: TurnExpansion,
): Promise<NodeResult> {
  const worlds = requiredOpponentWorlds(expansion);
  const movesById = new Map(
    expansion.moves.map((move) => [moveId(move), move] as const),
  );
  const staticScores = new Map<string, number>();
  const outcomes: WorldScoreOutcome[] = [];
  for (const world of worlds) {
    if (world.terminalScore !== null) {
      outcomes.push({
        hypothesisId: world.hypothesisId,
        probability: world.probability,
        score: world.terminalScore,
        replyId: null,
      });
      continue;
    }
    const captureId = firstKingCaptureId(world, movesById);
    if (captureId === undefined) {
      const maskId = [...world.legalMoveIds].sort().join(",");
      let staticScore = staticScores.get(maskId);
      if (staticScore === undefined) {
        staticScore = await evaluateStaticLeaf(
          node,
          state,
          movesForWorld(world, movesById),
        );
        staticScores.set(maskId, staticScore);
      }
      outcomes.push({
        hypothesisId: world.hypothesisId,
        probability: world.probability,
        score: staticScore,
        replyId: null,
      });
      continue;
    }
    outcomes.push({
      hypothesisId: world.hypothesisId,
      probability: world.probability,
      score: -TERMINAL_SCORE + ply + 1,
      replyId: captureId,
    });
  }
  const aggregation = aggregateWorldOutcomes(state.aggregation, outcomes);
  const selectedCaptureId = [...aggregation.representativeMass.entries()].sort(
    ([leftId, leftMass], [rightId, rightMass]) =>
      rightMass - leftMass || leftId.localeCompare(rightId),
  )[0]?.[0];
  const selectedCapture =
    selectedCaptureId === undefined
      ? undefined
      : movesById.get(selectedCaptureId);
  return {
    score: aggregation.score,
    principalVariation:
      selectedCapture === undefined ? [] : [selectedCapture],
  };
}

function firstKingCaptureId(
  world: OpponentWorldExpansion,
  movesById: ReadonlyMap<string, ChessMove>,
): string | undefined {
  return [...world.legalMoveIds]
    .sort()
    .find((id) => movesById.get(id)?.captured === "king");
}

function movesForWorld(
  world: OpponentWorldExpansion,
  movesById: ReadonlyMap<string, ChessMove>,
): readonly ChessMove[] {
  return Object.freeze(
    [...world.legalMoveIds]
      .sort()
      .map((id) => {
        const move = movesById.get(id);
        if (move === undefined) {
          throw new Error(
            `${world.hypothesisId} permits missing leaf move ${id}.`,
          );
        }
        return move;
      }),
  );
}

async function evaluateStaticLeaf(
  node: PrivateNode,
  state: SearchState,
  moves: readonly ChessMove[],
): Promise<number> {
  state.leaves += 1;
  const publicPosition = node.position.snapshot();
  const score = await state.evaluator.evaluate(
    {
      authorityId: "capturable-king/v1",
      fen: node.position.fen,
      turn: node.position.turn,
      legalMoves: moves,
      history: node.history,
      orthodoxCompatible: node.position.orthodoxCompatible,
      kingPassantActive: publicPosition.kingPassant !== null,
    },
    state.limits.signal,
  );
  if (!Number.isFinite(score)) {
    throw new Error(`${state.evaluator.id} returned a non-finite leaf score.`);
  }
  return node.position.turn === state.rootColor ? score : -score;
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
  if (!PLAYER_PRIVATE_AGGREGATIONS.has(input.aggregation)) {
    throw new RangeError(
      "Player-private aggregation must be worst-case, posterior-expected, "
        + "or posterior-cvar-25.",
    );
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
