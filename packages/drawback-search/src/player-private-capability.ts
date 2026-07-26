import {
  advancePublicGameTrace,
  advancePublicPositionAuthority,
  inspectPublicGameTrace,
  publicAuthorityLegalMoves,
  publicGameTraceView,
  type MoveCommand,
  type PublicGameTrace,
  type PublicPositionAuthoritySnapshot,
} from "@drawbackengine/chess-core";
import type {
  ChessMove,
  DrawbackLoss,
  DrawbackRule,
  PositionAuthorityId,
  PositionView,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";

interface RuleBehaviorCapability {
  readonly authorityId: PositionAuthorityId;
  readonly color: PlayerColor;
  readonly drawbackId: string;
  fork(): RuleBehaviorCapability;
  legalMoves(
    position: PositionView,
    authorityMoves: readonly ChessMove[],
  ): readonly ChessMove[];
  applyMove(
    positionBefore: PositionView,
    positionAfter: PositionView,
    move: ChessMove,
  ): RuleBehaviorCapability;
  checkStartOfTurnLoss(position: PositionView): DrawbackLoss | null;
}

export interface OwnPlayerRuleCapability extends RuleBehaviorCapability {
  readonly capabilityKind: "own-player-rule";
  fork(): OwnPlayerRuleCapability;
  applyMove(
    positionBefore: PositionView,
    positionAfter: PositionView,
    move: ChessMove,
  ): OwnPlayerRuleCapability;
}

export interface PublicHypothesisRuleCapability extends RuleBehaviorCapability {
  readonly capabilityKind: "public-hypothesis-rule";
  fork(): PublicHypothesisRuleCapability;
  applyMove(
    positionBefore: PositionView,
    positionAfter: PositionView,
    move: ChessMove,
  ): PublicHypothesisRuleCapability;
}

export interface PublicDrawbackHypothesis {
  readonly hypothesisId: string;
  readonly probability: number;
  readonly capability: PublicHypothesisRuleCapability;
}

export type PublicRuleStateReconstructionFailure =
  | "authority-replay-diverged"
  | "hypothesis-already-lost"
  | "observed-move-illegal"
  | "final-position-diverged";

const ownCapabilities = new WeakSet();
const publicCapabilities = new WeakSet();
const currentPositions = new WeakMap<object, PositionView>();

export class PublicRuleStateReconstructionError extends Error {
  public readonly authorityId: PositionAuthorityId;
  public readonly color: PlayerColor;
  public readonly drawbackId: string;
  public readonly code: PublicRuleStateReconstructionFailure;
  public readonly reason: string;

  public constructor(
    authorityId: PositionAuthorityId,
    color: PlayerColor,
    drawbackId: string,
    code: PublicRuleStateReconstructionFailure,
    reason: string,
  ) {
    super(
      `Cannot reconstruct exact public state for ${drawbackId} under ${authorityId}: ${reason}`,
    );
    this.name = "PublicRuleStateReconstructionError";
    this.authorityId = authorityId;
    this.color = color;
    this.drawbackId = drawbackId;
    this.code = code;
    this.reason = reason;
  }
}

/**
 * Trusted coordinator boundary for the active player's own exact runtime.
 *
 * Mint this before handing a search request to player code. Never pass the
 * omniscient game session or the opponent's secret snapshot to that code.
 */
export function createOwnPlayerRuleCapability<State, Parameters>(
  authorityId: PositionAuthorityId,
  color: PlayerColor,
  rule: DrawbackRule<State, Parameters>,
  parameters: Readonly<Parameters>,
  state: Readonly<State>,
  currentPosition: PositionView,
): OwnPlayerRuleCapability {
  return mintCapability(
    "own-player-rule",
    authorityId,
    color,
    rule,
    parameters,
    state,
    currentPosition,
    null,
  ) as OwnPlayerRuleCapability;
}

/**
 * Reconstructs an opponent hypothesis only from a public rule candidate,
 * candidate parameters, and authenticated complete public authority replay.
 *
 * It deliberately accepts no authoritative internal rule state and no game
 * session. The resulting capability is runtime-branded separately from the
 * active player's own exact capability.
 */
export function createPublicDrawbackHypothesis<State, Parameters>(
  hypothesisId: string,
  probability: number,
  color: PlayerColor,
  rule: DrawbackRule<State, Parameters>,
  parameters: Readonly<Parameters>,
  trace: PublicGameTrace,
): PublicDrawbackHypothesis {
  if (hypothesisId.trim().length === 0) {
    throw new RangeError("Hypothesis ID must not be empty.");
  }
  if (!Number.isFinite(probability) || probability <= 0) {
    throw new RangeError(
      "Hypothesis probability must be finite and greater than zero.",
    );
  }
  const traced = inspectPublicGameTrace(trace);
  const authorityId = traced.origin.authorityId;
  if (
    traced.current.authorityId !== authorityId
    || trace.authorityId !== authorityId
  ) {
    throw new Error("Public game trace authority IDs diverged.");
  }
  assertSupportedAuthority(rule, authorityId);
  const validatedParameters: Readonly<Parameters> =
    rule.validateParameters === undefined
      ? parameters
      : rule.validateParameters(parameters);
  const replay = replayPublicRule(
    authorityId,
    color,
    rule,
    validatedParameters,
    trace,
  );
  return Object.freeze({
    hypothesisId,
    probability,
    capability: mintCapability(
      "public-hypothesis-rule",
      authorityId,
      color,
      rule,
      validatedParameters,
      replay.state,
      replay.currentPosition,
      trace,
    ) as PublicHypothesisRuleCapability,
  });
}

export function assertOwnPlayerCapability(
  capability: OwnPlayerRuleCapability,
  currentPosition: PositionView,
): void {
  if (
    !ownCapabilities.has(capability)
    || !samePosition(currentPositions.get(capability), currentPosition)
  ) {
    throw new TypeError(
      "Own rule capability was not minted for this public position.",
    );
  }
}

export function assertPublicHypothesisCapability(
  capability: PublicHypothesisRuleCapability,
  currentPosition: PositionView,
): void {
  if (
    !publicCapabilities.has(capability)
    || !samePosition(currentPositions.get(capability), currentPosition)
  ) {
    throw new TypeError(
      "Opponent hypothesis capability was not reconstructed for this public position.",
    );
  }
}

function mintCapability<State, Parameters>(
  kind: "own-player-rule" | "public-hypothesis-rule",
  authorityId: PositionAuthorityId,
  color: PlayerColor,
  rule: DrawbackRule<State, Parameters>,
  parameters: Readonly<Parameters>,
  state: Readonly<State>,
  currentPosition: PositionView,
  publicTrace: PublicGameTrace | null,
): RuleBehaviorCapability & {
  readonly capabilityKind: "own-player-rule" | "public-hypothesis-rule";
} {
  assertSupportedAuthority(rule, authorityId);
  const privateParameters = structuredClone(parameters);
  const privateState = structuredClone(state);
  const privatePosition = clonePosition(currentPosition);
  const privateTrace = publicTrace;

  const fork = () =>
    mintCapability(
      kind,
      authorityId,
      color,
      rule,
      privateParameters,
      privateState,
      privatePosition,
      privateTrace,
    );
  const applyMove = (
    positionBefore: PositionView,
    positionAfter: PositionView,
    move: ChessMove,
  ) => {
    if (!samePosition(privatePosition, positionBefore)) {
      throw new Error(`${rule.id} capability was applied out of sequence.`);
    }
    let nextTrace: PublicGameTrace | null = privateTrace;
    if (kind === "public-hypothesis-rule") {
      if (privateTrace === null) {
        throw new Error(`${rule.id} public capability has no game trace.`);
      }
      nextTrace = advancePublicGameTrace(privateTrace, moveCommand(move));
      const tracedPosition = publicGameTraceView(nextTrace);
      const tracedMove = inspectPublicGameTrace(nextTrace).moves.at(-1);
      if (
        tracedMove === undefined
        || !sameMoveDetails(tracedMove, move)
        || !samePosition(tracedPosition, positionAfter)
      ) {
        throw new Error(
          `${rule.id} public capability transition does not match its game trace.`,
        );
      }
    }
    const nextState = move.color === color
      ? rule.applyMove(
          {
            color,
            parameters: structuredClone(privateParameters),
            state: structuredClone(privateState),
            position: clonePosition(positionBefore),
            positionAfterMove: clonePosition(positionAfter),
          },
          structuredClone(move),
        )
      : privateState;
    return mintCapability(
      kind,
      authorityId,
      color,
      rule,
      privateParameters,
      nextState,
      positionAfter,
      nextTrace,
    );
  };
  const capability = Object.freeze({
    authorityId,
    color,
    drawbackId: rule.id,
    capabilityKind: kind,
    fork,
    legalMoves: (
      position: PositionView,
      authorityMoves: readonly ChessMove[],
    ) => {
      if (!samePosition(privatePosition, position)) {
        throw new Error(`${rule.id} capability queried out of sequence.`);
      }
      const filtered = rule.filterLegalMoves(
        {
          color,
          parameters: structuredClone(privateParameters),
          state: structuredClone(privateState),
          position: clonePosition(position),
        },
        structuredClone(authorityMoves),
      );
      return validateFilteredMoves(rule.id, authorityMoves, filtered);
    },
    applyMove,
    checkStartOfTurnLoss: (position: PositionView) => {
      if (!samePosition(privatePosition, position)) {
        throw new Error(`${rule.id} capability queried out of sequence.`);
      }
      return structuredClone(
        rule.checkStartOfTurnLoss({
          color,
          parameters: structuredClone(privateParameters),
          state: structuredClone(privateState),
          position: clonePosition(position),
        }),
      );
    },
  });
  currentPositions.set(capability, privatePosition);
  if (kind === "own-player-rule") {
    ownCapabilities.add(capability);
    return capability;
  }
  publicCapabilities.add(capability);
  return capability;
}

interface PublicRuleReplay<State> {
  readonly state: State;
  readonly currentPosition: PositionView;
}

function replayPublicRule<State, Parameters>(
  authorityId: PositionAuthorityId,
  color: PlayerColor,
  rule: DrawbackRule<State, Parameters>,
  parameters: Readonly<Parameters>,
  trace: PublicGameTrace,
): PublicRuleReplay<State> {
  const traced = inspectPublicGameTrace(trace);
  let snapshot = traced.origin;
  let history: readonly ChessMove[] = Object.freeze([]);
  let position = positionView(snapshot, history);
  let state = rule.initialize({
    color,
    parameters: structuredClone(parameters),
    position,
  });
  for (const [index, expectedMove] of traced.moves.entries()) {
    const authorityMoves = publicAuthorityLegalMoves(snapshot);
    const transition = advancePublicPositionAuthority(
      snapshot,
      moveCommand(expectedMove),
    );
    if (!sameMoveDetails(transition.move, expectedMove)) {
      throw new PublicRuleStateReconstructionError(
        authorityId,
        color,
        rule.id,
        "authority-replay-diverged",
        `Authority replay changed public move ${String(index)}.`,
      );
    }
    const nextHistory = Object.freeze([
      ...history,
      Object.freeze(structuredClone(transition.move)),
    ]);
    const positionAfterMove = positionView(
      transition.position,
      nextHistory,
    );
    if (expectedMove.color === color) {
      const loss = rule.checkStartOfTurnLoss({
        color,
        parameters: structuredClone(parameters),
        state: structuredClone(state),
        position,
      });
      if (loss !== null) {
        throw new PublicRuleStateReconstructionError(
          authorityId,
          color,
          rule.id,
          "hypothesis-already-lost",
          `Public move ${String(index)} occurred after the hypothesis had already lost.`,
        );
      }
      const filtered = validateFilteredMoves(
        rule.id,
        authorityMoves,
        rule.filterLegalMoves(
          {
            color,
            parameters: structuredClone(parameters),
            state: structuredClone(state),
            position,
          },
          structuredClone(authorityMoves),
        ),
      );
      if (!filtered.some((candidate) => sameMove(candidate, transition.move))) {
        throw new PublicRuleStateReconstructionError(
          authorityId,
          color,
          rule.id,
          "observed-move-illegal",
          `Public move ${String(index)} contradicts the hypothesis legal mask.`,
        );
      }
      state = rule.applyMove(
        {
          color,
          parameters: structuredClone(parameters),
          state: structuredClone(state),
          position,
          positionAfterMove,
        },
        structuredClone(transition.move),
      );
    }
    snapshot = transition.position;
    history = nextHistory;
    position = positionAfterMove;
  }
  if (
    JSON.stringify(snapshot) !== JSON.stringify(traced.current)
    || !samePosition(position, publicGameTraceView(trace))
  ) {
    throw new PublicRuleStateReconstructionError(
      authorityId,
      color,
      rule.id,
      "final-position-diverged",
      "Public rule replay did not reach the authenticated trace position.",
    );
  }
  return { state, currentPosition: position };
}

function positionView(
  snapshot: PublicPositionAuthoritySnapshot,
  history: readonly ChessMove[],
): PositionView {
  const activeColor = snapshot.fen.split(/\s+/u)[1];
  if (activeColor !== "w" && activeColor !== "b") {
    throw new TypeError("Public authority FEN has no valid active color.");
  }
  return Object.freeze({
    fen: snapshot.fen,
    turn: activeColor === "w" ? "white" : "black",
    ply: history.length,
    history: Object.freeze(structuredClone([...history])),
  });
}

function moveCommand(move: ChessMove): MoveCommand {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
}

function assertSupportedAuthority<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
  authorityId: PositionAuthorityId,
): void {
  if (!rule.supportedAuthorities?.includes(authorityId)) {
    throw new Error(`${rule.id} has not been audited for ${authorityId}.`);
  }
}

function validateFilteredMoves(
  ruleId: string,
  authorityMoves: readonly ChessMove[],
  filtered: readonly ChessMove[],
): readonly ChessMove[] {
  const result: ChessMove[] = [];
  const seen = new Set<string>();
  for (const candidate of filtered) {
    const source = authorityMoves.find((move) => sameMove(move, candidate));
    if (source === undefined) {
      throw new Error(
        `${ruleId} manufactured ${moveId(candidate)} outside the position authority.`,
      );
    }
    const id = moveId(source);
    if (seen.has(id)) {
      throw new Error(`${ruleId} returned duplicate move ${id}.`);
    }
    seen.add(id);
    result.push(Object.freeze(structuredClone(source)));
  }
  return Object.freeze(result);
}

function clonePosition(position: PositionView): PositionView {
  return structuredClone(position);
}

function samePosition(
  left: PositionView | undefined,
  right: PositionView,
): boolean {
  return (
    left !== undefined
    && left.fen === right.fen
    && left.turn === right.turn
    && left.ply === right.ply
    && left.history.length === right.history.length
    && left.history.every((move, index) => {
      const other = right.history[index];
      return other !== undefined && sameMoveDetails(move, other);
    })
  );
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

function sameMoveDetails(left: ChessMove, right: ChessMove): boolean {
  return (
    sameMove(left, right)
    && left.color === right.color
    && left.piece === right.piece
    && left.captured === right.captured
    && left.san === right.san
    && left.flags === right.flags
  );
}

function moveId(
  move: Pick<ChessMove, "from" | "to" | "promotion">,
): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}
