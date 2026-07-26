import type {
  ExternalConstraintDrawbackRule,
  ExternalTurnConstraint,
  ExternalTurnConstraintRequest,
} from "../external-constraints.js";
import type {
  ChessMove,
  PositionView,
  PromotionPiece,
  RuleMoveContext,
} from "../types.js";
import type { NoParameters } from "./common.js";

export interface EvaluatorBackedRuleState {
  readonly movesApplied: number;
}

const POLICY_ID = "stockfish-bestmove-v1";
const PROVIDER = "uci-best-move";

const PROMOTION_SYMBOL: Readonly<Record<PromotionPiece, string>> = {
  knight: "n",
  bishop: "b",
  rook: "r",
  queen: "q",
};

const CANONICAL_UCI = /^[a-h][1-8][a-h][1-8][nbrq]?$/u;

export function canonicalMoveUci(move: ChessMove): string {
  const uci =
    `${move.from}${move.to}` +
    (move.promotion === undefined ? "" : PROMOTION_SYMBOL[move.promotion]);
  if (!CANONICAL_UCI.test(uci)) {
    throw new RangeError(`Move cannot be represented as canonical UCI: ${uci}.`);
  }
  return uci;
}

function canonicalRoots(moves: readonly ChessMove[]): readonly string[] {
  const roots = moves.map(canonicalMoveUci).sort();
  if (new Set(roots).size !== roots.length) {
    throw new RangeError("Ordinary root moves must have unique canonical UCI.");
  }
  return Object.freeze(roots);
}

function positionKey(fen: string, roots: readonly string[]): string {
  return JSON.stringify([fen, [...roots].sort()]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function createEvaluatorTurnConstraintRequest(
  position: PositionView,
  ordinaryMoves: readonly ChessMove[],
): ExternalTurnConstraintRequest {
  const roots = canonicalRoots(ordinaryMoves);
  return Object.freeze({
    provider: PROVIDER,
    policyId: POLICY_ID,
    positionKey: positionKey(position.fen, roots),
    fen: position.fen,
    ordinaryRootMoves: roots,
  });
}

function request(
  context: RuleMoveContext<EvaluatorBackedRuleState, NoParameters>,
  ordinaryMoves: readonly ChessMove[],
): ExternalTurnConstraintRequest {
  return createEvaluatorTurnConstraintRequest(context.position, ordinaryMoves);
}

function constrainedBestMove(
  context: RuleMoveContext<EvaluatorBackedRuleState, NoParameters>,
  ordinaryMoves: readonly ChessMove[],
  constraint: ExternalTurnConstraint,
): ChessMove {
  const candidate: unknown = constraint;
  if (!isRecord(candidate)) {
    throw new TypeError("An external turn constraint is required.");
  }
  if (candidate["provider"] !== PROVIDER) {
    throw new Error("External constraint provider does not match the request.");
  }
  if (candidate["policyId"] !== POLICY_ID) {
    throw new Error("External constraint policy does not match the request.");
  }
  const roots = canonicalRoots(ordinaryMoves);
  if (
    candidate["positionKey"] !== positionKey(context.position.fen, roots)
  ) {
    throw new Error("External constraint position does not match the request.");
  }
  if (
    typeof candidate["engineFingerprint"] !== "string" ||
    candidate["engineFingerprint"].trim().length === 0
  ) {
    throw new TypeError("External constraint engine fingerprint is invalid.");
  }
  if (
    typeof candidate["requestDigest"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate["requestDigest"])
  ) {
    throw new TypeError("External constraint request digest is invalid.");
  }
  if (
    typeof candidate["bestMoveUci"] !== "string" ||
    !CANONICAL_UCI.test(candidate["bestMoveUci"])
  ) {
    throw new TypeError("External constraint best move is not canonical UCI.");
  }
  const bestMove = ordinaryMoves.find(
    (move) => canonicalMoveUci(move) === candidate["bestMoveUci"],
  );
  if (bestMove === undefined) {
    throw new RangeError(
      "External constraint best move is outside the ordinary root mask.",
    );
  }
  return bestMove;
}

function initialize(
  context: Parameters<
    ExternalConstraintDrawbackRule<
      EvaluatorBackedRuleState,
      NoParameters
    >["initialize"]
  >[0],
): EvaluatorBackedRuleState {
  return Object.freeze({
    movesApplied: context.position.history.filter(
      (move) => move.color === context.color,
    ).length,
  });
}

function applyMove(
  context: Parameters<
    ExternalConstraintDrawbackRule<
      EvaluatorBackedRuleState,
      NoParameters
    >["applyMove"]
  >[0],
): EvaluatorBackedRuleState {
  return Object.freeze({ movesApplied: context.state.movesApplied + 1 });
}

const shared = {
  kind: "external-turn-constraint" as const,
  verification: "implemented-unverified" as const,
  generateParameters: (): NoParameters => ({}),
  initialize,
  requestTurnConstraint: request,
  applyMove,
  checkStartOfTurnLoss: () => null,
};

export const handAndGigabrainRule: ExternalConstraintDrawbackRule<
  EvaluatorBackedRuleState,
  NoParameters
> = {
  ...shared,
  id: "hand-and-gigabrain",
  name: "Hand and Gigabrain",
  description:
    "You must move the piece type selected by the prepared evaluator constraint.",
  filterLegalMovesWithConstraint: (context, ordinaryMoves, constraint) => {
    const bestMove = constrainedBestMove(context, ordinaryMoves, constraint);
    return ordinaryMoves.filter((move) => move.piece === bestMove.piece);
  },
};

export const ichtyophobeRule: ExternalConstraintDrawbackRule<
  EvaluatorBackedRuleState,
  NoParameters
> = {
  ...shared,
  id: "ichtyophobe",
  name: "Ichtyophobe",
  description:
    "You cannot make the exact move selected by the prepared evaluator constraint.",
  filterLegalMovesWithConstraint: (context, ordinaryMoves, constraint) => {
    const bestMove = constrainedBestMove(context, ordinaryMoves, constraint);
    return ordinaryMoves.filter((move) => move !== bestMove);
  },
};
