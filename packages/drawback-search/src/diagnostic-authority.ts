import {
  advancePublicPositionAuthority,
  inspectPublicGameTrace,
  publicAuthorityLegalMoves,
  type MoveCommand,
  type PublicPositionAuthoritySnapshot,
} from "@drawbackengine/chess-core";
import type {
  ChessMove,
  PositionView,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";
import { Chess as OrthodoxChess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import type {
  AuthorityDiagnosticReply,
  DiagnosticTerminal,
  PlayerPrivateDiagnosticInput,
} from "./diagnostic-assessment-types.js";
import type {
  OwnPlayerRuleCapability,
  PublicDrawbackHypothesis,
} from "./player-private-capability.js";
import {
  assertOwnPlayerCapability,
  assertPublicHypothesisCapability,
} from "./player-private-capability.js";

const TERMINAL_SCORE = 1_000_000;

export interface ValidatedDiagnosticRequest {
  readonly position: PublicPositionAuthoritySnapshot;
  readonly currentPosition: PositionView;
  readonly rootColor: PlayerColor;
  readonly candidates: readonly ChessMove[];
  readonly normalizedOpponent: readonly PublicDrawbackHypothesis[];
  readonly supportedMass: number;
  readonly unsupportedMass: number;
}

export interface PreparedDiagnosticScenario {
  readonly hypothesis: PublicDrawbackHypothesis;
  readonly outcomes: readonly AuthorityDiagnosticReply[];
}

export interface PreparedDiagnosticCandidate {
  readonly move: ChessMove;
  readonly positionAfterMove: PublicPositionAuthoritySnapshot;
  readonly historyAfterMove: readonly ChessMove[];
  readonly scenarios: readonly PreparedDiagnosticScenario[];
}

export function validateDiagnosticRequest(
  input: PlayerPrivateDiagnosticInput,
): ValidatedDiagnosticRequest {
  const traced = inspectPublicGameTrace(input.trace);
  const position = traced.current;
  if (input.evaluator.id.trim().length === 0) {
    throw new RangeError("Diagnostic evaluator ID must not be empty.");
  }
  if (
    input.standardRepetitionAdjudicator !== undefined
    && input.standardRepetitionAdjudicator.id.trim().length === 0
  ) {
    throw new RangeError(
      "Standard repetition adjudicator ID must not be empty.",
    );
  }
  const history = immutableDiagnosticMoves(traced.moves);
  const currentPosition = publicPositionView(position, history);
  if (input.own.authorityId !== position.authorityId) {
    throw new Error("Own rule capability uses the wrong position authority.");
  }
  if (input.own.color !== currentPosition.turn) {
    throw new Error("Own rule capability color must be the side to move.");
  }
  assertOwnPlayerCapability(input.own, currentPosition);
  if (input.own.checkStartOfTurnLoss(currentPosition) !== null) {
    throw new Error("Cannot assess a position already lost by the root drawback.");
  }
  const authorityMoves = publicAuthorityLegalMoves(position);
  const ownMoves = input.own.legalMoves(currentPosition, authorityMoves);
  if (ownMoves.length === 0) {
    throw new Error("Active player-private position has no legal moves.");
  }
  const candidates = selectCandidates(ownMoves, input.candidateMoves);

  if (
    input.opponent.length === 0
    && input.unsupportedOpponentAuthorities.length === 0
  ) {
    throw new RangeError(
      "Diagnostic assessment requires at least one opponent hypothesis.",
    );
  }
  const opponentColor = opposite(currentPosition.turn);
  const ids = new Set<string>();
  let supportedMass = 0;
  for (const hypothesis of input.opponent) {
    validateUniqueHypothesisId(ids, hypothesis.hypothesisId);
    if (hypothesis.capability.authorityId !== position.authorityId) {
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
    validatePositiveProbability(
      hypothesis.probability,
      hypothesis.hypothesisId,
    );
    supportedMass += hypothesis.probability;
  }
  let unsupportedMass = 0;
  for (const fact of input.unsupportedOpponentAuthorities) {
    validateUniqueHypothesisId(ids, fact.hypothesisId);
    validatePositiveProbability(fact.probability, fact.hypothesisId);
    if (fact.drawbackId.trim().length === 0) {
      throw new RangeError("Unsupported drawback ID must not be empty.");
    }
    if (fact.authorityId.trim().length === 0) {
      throw new RangeError("Unsupported authority ID must not be empty.");
    }
    if (fact.reason.trim().length === 0) {
      throw new RangeError("Unsupported authority reason must not be empty.");
    }
    unsupportedMass += fact.probability;
  }
  const totalMass = supportedMass + unsupportedMass;
  if (!Number.isFinite(totalMass) || totalMass <= 0) {
    throw new RangeError(
      "Diagnostic hypothesis probabilities must have positive finite mass.",
    );
  }
  const normalizedOpponent = Object.freeze(
    supportedMass === 0
      ? []
      : input.opponent.map((hypothesis) =>
          Object.freeze({
            hypothesisId: hypothesis.hypothesisId,
            probability: hypothesis.probability / supportedMass,
            capability: hypothesis.capability.fork(),
          })
        ),
  );
  return Object.freeze({
    position,
    currentPosition,
    rootColor: currentPosition.turn,
    candidates,
    normalizedOpponent,
    supportedMass,
    unsupportedMass,
  });
}

export function prepareDiagnosticCandidate(
  input: PlayerPrivateDiagnosticInput,
  request: ValidatedDiagnosticRequest,
  move: ChessMove,
): PreparedDiagnosticCandidate {
  throwIfDiagnosticAborted(input.signal);
  const transition = advancePublicPositionAuthority(
    request.position,
    command(move),
  );
  const historyAfterMove = Object.freeze([
    ...request.currentPosition.history,
    immutableDiagnosticMove(transition.move),
  ]);
  const positionAfterMove = publicPositionView(
    transition.position,
    historyAfterMove,
  );
  const authorityTerminal = immediateAuthorityTerminal(transition.position);
  if (authorityTerminal !== null) {
    const terminalReply = immutableTerminalReply(
      transition.position,
      authorityTerminal,
    );
    return Object.freeze({
      move: immutableDiagnosticMove(move),
      positionAfterMove: transition.position,
      historyAfterMove,
      scenarios: Object.freeze(
        request.normalizedOpponent.map((hypothesis) =>
          Object.freeze({
            hypothesis,
            outcomes: Object.freeze([terminalReply]),
          })
        ),
      ),
    });
  }

  const ownAfterMove = input.own.applyMove(
    request.currentPosition,
    positionAfterMove,
    transition.move,
  );
  const scenarios = request.normalizedOpponent.map((hypothesis) =>
    prepareScenario(
      request.rootColor,
      input,
      transition.position,
      historyAfterMove,
      ownAfterMove,
      hypothesis,
      request.currentPosition,
      positionAfterMove,
      transition.move,
    )
  );
  return Object.freeze({
    move: immutableDiagnosticMove(move),
    positionAfterMove: transition.position,
    historyAfterMove,
    scenarios: Object.freeze(scenarios),
  });
}

function prepareScenario(
  rootColor: PlayerColor,
  input: PlayerPrivateDiagnosticInput,
  positionAfterRoot: PublicPositionAuthoritySnapshot,
  historyAfterRoot: readonly ChessMove[],
  ownAfterRoot: OwnPlayerRuleCapability,
  hypothesis: PublicDrawbackHypothesis,
  positionBeforeRoot: PositionView,
  viewAfterRoot: PositionView,
  rootMove: ChessMove,
): PreparedDiagnosticScenario {
  const opponentAfterRoot = hypothesis.capability.applyMove(
    positionBeforeRoot,
    viewAfterRoot,
    rootMove,
  );
  const opponentLoss = opponentAfterRoot.checkStartOfTurnLoss(viewAfterRoot);
  if (opponentLoss !== null) {
    return terminalScenario(
      hypothesis,
      positionAfterRoot,
      drawbackLossTerminal(opponentLoss.color, opponentLoss.ruleId),
    );
  }
  const authorityReplies = publicAuthorityLegalMoves(positionAfterRoot);
  if (authorityReplies.length === 0) {
    return terminalScenario(
      hypothesis,
      positionAfterRoot,
      authorityNoLegalMovesTerminal(
        input,
        positionAfterRoot,
        historyAfterRoot,
        opposite(rootColor),
      ),
    );
  }
  const permitted = opponentAfterRoot.legalMoves(
    viewAfterRoot,
    authorityReplies,
  );
  if (permitted.length === 0) {
    return terminalScenario(
      hypothesis,
      positionAfterRoot,
      Object.freeze({
        kind: "no-drawback-legal-replies",
        winner: rootColor,
        loser: opposite(rootColor),
        drawbackId: opponentAfterRoot.drawbackId,
      }),
    );
  }
  const standardTerminal = standardAuthorityTerminal(
    input,
    positionAfterRoot,
    historyAfterRoot,
  );
  if (standardTerminal !== null) {
    return terminalScenario(hypothesis, positionAfterRoot, standardTerminal);
  }
  const outcomes = permitted.map((reply) =>
    prepareReplyOutcome(
      rootColor,
      input,
      positionAfterRoot,
      historyAfterRoot,
      ownAfterRoot,
      viewAfterRoot,
      reply,
    )
  );
  return Object.freeze({
    hypothesis,
    outcomes: Object.freeze(outcomes),
  });
}

function prepareReplyOutcome(
  rootColor: PlayerColor,
  input: PlayerPrivateDiagnosticInput,
  positionBeforeReply: PublicPositionAuthoritySnapshot,
  historyBeforeReply: readonly ChessMove[],
  ownBeforeReply: OwnPlayerRuleCapability,
  viewBeforeReply: PositionView,
  reply: ChessMove,
): AuthorityDiagnosticReply {
  const transition = advancePublicPositionAuthority(
    positionBeforeReply,
    command(reply),
  );
  const historyAfterReply = Object.freeze([
    ...historyBeforeReply,
    immutableDiagnosticMove(transition.move),
  ]);
  const viewAfterReply = publicPositionView(
    transition.position,
    historyAfterReply,
  );
  const authorityTerminal = immediateAuthorityTerminal(transition.position);
  if (authorityTerminal !== null) {
    return immutableTerminalReply(
      transition.position,
      authorityTerminal,
      transition.move,
    );
  }
  const ownAfterReply = ownBeforeReply.applyMove(
    viewBeforeReply,
    viewAfterReply,
    transition.move,
  );
  const rootLoss = ownAfterReply.checkStartOfTurnLoss(viewAfterReply);
  if (rootLoss !== null) {
    return immutableTerminalReply(
      transition.position,
      drawbackLossTerminal(rootLoss.color, rootLoss.ruleId),
      transition.move,
    );
  }
  if (viewAfterReply.turn !== rootColor) {
    throw new Error("Authority reply did not return the turn to the root player.");
  }
  const rootAuthorityMoves = publicAuthorityLegalMoves(transition.position);
  if (rootAuthorityMoves.length === 0) {
    return immutableTerminalReply(
      transition.position,
      authorityNoLegalMovesTerminal(
        input,
        transition.position,
        historyAfterReply,
        rootColor,
      ),
      transition.move,
    );
  }
  if (ownAfterReply.legalMoves(viewAfterReply, rootAuthorityMoves).length === 0) {
    return immutableTerminalReply(
      transition.position,
      drawbackLossTerminal(rootColor, ownAfterReply.drawbackId),
      transition.move,
    );
  }
  const standardTerminal = standardAuthorityTerminal(
    input,
    transition.position,
    historyAfterReply,
  );
  if (standardTerminal !== null) {
    return immutableTerminalReply(
      transition.position,
      standardTerminal,
      transition.move,
    );
  }
  return Object.freeze({
    kind: "move",
    move: immutableDiagnosticMove(transition.move),
    position: transition.position,
  });
}

export function currentStandardTerminal(
  input: PlayerPrivateDiagnosticInput,
  request: ValidatedDiagnosticRequest,
): DiagnosticTerminal | null {
  return standardAuthorityTerminal(
    input,
    request.position,
    request.currentPosition.history,
  );
}

export function diagnosticTerminalScore(
  terminal: DiagnosticTerminal,
  rootColor: PlayerColor,
  ply: number,
): number {
  if (terminal.winner === null) {
    return 0;
  }
  return terminal.winner === rootColor
    ? TERMINAL_SCORE - ply
    : -TERMINAL_SCORE + ply;
}

export function requiredPreparedCandidate(
  candidates: readonly PreparedDiagnosticCandidate[],
  move: ChessMove,
): PreparedDiagnosticCandidate {
  const candidate = candidates.find((entry) => sameMove(entry.move, move));
  if (candidate === undefined) {
    throw new Error(`Missing prepared candidate ${diagnosticMoveId(move)}.`);
  }
  return candidate;
}

export function requiredPreparedScenario(
  scenarios: ReadonlyMap<string, PreparedDiagnosticScenario>,
  move: ChessMove,
  hypothesisId: string,
): PreparedDiagnosticScenario {
  const scenario = scenarios.get(diagnosticScenarioKey(move, hypothesisId));
  if (scenario === undefined) {
    throw new Error(
      `Missing diagnostic scenario ${diagnosticMoveId(move)} / ${hypothesisId}.`,
    );
  }
  return scenario;
}

export function diagnosticScenarioKey(
  move: ChessMove,
  hypothesisId: string,
): string {
  return `${diagnosticMoveId(move)}::${hypothesisId}`;
}

export function diagnosticReplyKey(
  reply: AuthorityDiagnosticReply,
): string {
  const positionKey = JSON.stringify(reply.position);
  return reply.kind === "move"
    ? `move:${diagnosticMoveId(reply.move)}:${positionKey}`
    : `terminal:${
      reply.reply === undefined ? "" : diagnosticMoveId(reply.reply)
    }:${JSON.stringify(reply.terminal)}:${positionKey}`;
}

function terminalScenario(
  hypothesis: PublicDrawbackHypothesis,
  position: PublicPositionAuthoritySnapshot,
  terminal: DiagnosticTerminal,
): PreparedDiagnosticScenario {
  return Object.freeze({
    hypothesis,
    outcomes: Object.freeze([
      immutableTerminalReply(position, terminal),
    ]),
  });
}

function immediateAuthorityTerminal(
  position: PublicPositionAuthoritySnapshot,
): DiagnosticTerminal | null {
  if (
    position.authorityId !== "capturable-king/v1"
    || position.terminal === null
  ) {
    return null;
  }
  return Object.freeze({
    kind: "king-capture",
    winner: position.terminal.winner,
    loser: position.terminal.capturedKing,
    method: position.terminal.method,
  });
}

function authorityNoLegalMovesTerminal(
  input: PlayerPrivateDiagnosticInput,
  position: PublicPositionAuthoritySnapshot,
  history: readonly ChessMove[],
  sideToMove: PlayerColor,
): DiagnosticTerminal {
  if (position.authorityId === "capturable-king/v1") {
    return Object.freeze({
      kind: "no-legal-moves",
      winner: opposite(sideToMove),
      loser: sideToMove,
    });
  }
  const terminal = standardAuthorityTerminal(input, position, history);
  if (
    terminal?.kind !== "checkmate"
    && !(terminal?.kind === "draw" && terminal.reason === "stalemate")
  ) {
    throw new Error(
      "standard-chess/v1 returned no authority moves without checkmate or stalemate.",
    );
  }
  return terminal;
}

function standardAuthorityTerminal(
  input: PlayerPrivateDiagnosticInput,
  position: PublicPositionAuthoritySnapshot,
  history: readonly ChessMove[],
): DiagnosticTerminal | null {
  if (position.authorityId !== "standard-chess/v1") {
    return null;
  }
  const orthodox = OrthodoxChess.fromSetup(
    parseFen(position.fen).unwrap(),
  ).unwrap();
  const context = orthodox.ctx();
  if (orthodox.isCheckmate(context)) {
    return Object.freeze({
      kind: "checkmate",
      winner: opposite(orthodox.turn),
      loser: orthodox.turn,
    });
  }
  if (orthodox.isStalemate(context)) {
    return Object.freeze({
      kind: "draw",
      winner: null,
      reason: "stalemate",
    });
  }
  const adjudicator = input.standardRepetitionAdjudicator;
  if (adjudicator === undefined) {
    throw new Error(
      "Standard terminal assessment requires repetition provenance.",
    );
  }
  const repetition: unknown = adjudicator.adjudicate({
    position,
    history: immutableDiagnosticMoves(history),
  });
  if (repetition === "threefold-repetition") {
    return Object.freeze({
      kind: "draw",
      winner: null,
      reason: "threefold-repetition",
    });
  }
  if (repetition !== "not-threefold-repetition") {
    throw new TypeError(
      `${adjudicator.id} returned an invalid repetition adjudication.`,
    );
  }
  if (orthodox.isInsufficientMaterial()) {
    return Object.freeze({
      kind: "draw",
      winner: null,
      reason: "insufficient-material",
    });
  }
  if (orthodox.halfmoves >= 100) {
    return Object.freeze({
      kind: "draw",
      winner: null,
      reason: "fifty-move",
    });
  }
  return null;
}

function drawbackLossTerminal(
  loser: PlayerColor,
  drawbackId: string,
): DiagnosticTerminal {
  return Object.freeze({
    kind: "drawback-loss",
    winner: opposite(loser),
    loser,
    drawbackId,
  });
}

function immutableTerminalReply(
  position: PublicPositionAuthoritySnapshot,
  terminal: DiagnosticTerminal,
  reply?: ChessMove,
): AuthorityDiagnosticReply {
  return Object.freeze({
    kind: "terminal",
    terminal,
    position,
    ...(reply === undefined
      ? {}
      : { reply: immutableDiagnosticMove(reply) }),
  });
}

function selectCandidates(
  legalMoves: readonly ChessMove[],
  supplied: readonly ChessMove[] | undefined,
): readonly ChessMove[] {
  if (supplied === undefined) {
    return immutableDiagnosticMoves(legalMoves);
  }
  if (supplied.length === 0) {
    throw new RangeError(
      "Diagnostic assessment requires at least one candidate move.",
    );
  }
  const seen = new Set<string>();
  const candidates = supplied.map((candidate) => {
    const id = diagnosticMoveId(candidate);
    if (seen.has(id)) {
      throw new RangeError(`Duplicate diagnostic candidate move: ${id}.`);
    }
    seen.add(id);
    const legal = legalMoves.find((move) => sameMove(move, candidate));
    if (legal === undefined) {
      throw new RangeError(
        `Diagnostic candidate ${id} is not legal under the player's drawback.`,
      );
    }
    return immutableDiagnosticMove(legal);
  });
  return Object.freeze(candidates);
}

export function publicPositionView(
  position: PublicPositionAuthoritySnapshot,
  history: readonly ChessMove[],
): PositionView {
  const fields = position.fen.trim().split(/\s+/u);
  const active = fields[1];
  if (active !== "w" && active !== "b") {
    throw new TypeError("Public authority FEN has no valid active color.");
  }
  return Object.freeze({
    fen: position.fen,
    turn: active === "w" ? "white" : "black",
    ply: history.length,
    history,
  });
}

function command(move: ChessMove): MoveCommand {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
}

function validateUniqueHypothesisId(
  ids: Set<string>,
  hypothesisId: string,
): void {
  if (hypothesisId.trim().length === 0) {
    throw new RangeError("Hypothesis ID must not be empty.");
  }
  if (ids.has(hypothesisId)) {
    throw new RangeError(`Duplicate opponent hypothesis: ${hypothesisId}.`);
  }
  ids.add(hypothesisId);
}

function validatePositiveProbability(
  probability: number,
  hypothesisId: string,
): void {
  if (!Number.isFinite(probability) || probability <= 0) {
    throw new RangeError(
      `${hypothesisId} has invalid probability mass.`,
    );
  }
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

export function diagnosticMoveId(
  move: Pick<ChessMove, "from" | "to" | "promotion">,
): string {
  return `${move.from}${move.to}${move.promotion?.[0] ?? ""}`;
}

export function immutableDiagnosticMove(move: ChessMove): ChessMove {
  return Object.freeze(structuredClone(move));
}

export function immutableDiagnosticMoves(
  moves: readonly ChessMove[],
): readonly ChessMove[] {
  return Object.freeze(moves.map(immutableDiagnosticMove));
}

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

export function throwIfDiagnosticAborted(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted === true) {
    throw new DOMException(
      "Player-private diagnostic assessment was aborted.",
      "AbortError",
    );
  }
}
