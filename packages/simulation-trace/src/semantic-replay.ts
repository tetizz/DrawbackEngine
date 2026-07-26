import {
  advancePublicPositionAuthority,
  createStandardChessPositionSnapshot,
  publicAuthorityLegalMoves,
  type PublicPositionAuthoritySnapshot,
} from "@drawbackengine/chess-core";
import type {
  ChessMove,
  PositionView,
  PromotionPiece,
} from "@drawbackengine/drawback-engine";
import {
  canonicalMoveUci,
  createEvaluatorTurnConstraintRequest,
} from "@drawbackengine/drawback-engine";
import type { PrivateSimulationTracePly } from "./types.js";

const UCI_PROMOTION: Readonly<Record<string, PromotionPiece>> = {
  b: "bishop",
  n: "knight",
  q: "queen",
  r: "rook",
};

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((entry) => rightSet.has(entry));
}

function commandFromUci(uci: string): {
  readonly from: string;
  readonly to: string;
  readonly promotion?: PromotionPiece;
} {
  const promotionSymbol = uci[4];
  const promotion =
    promotionSymbol === undefined ? undefined : UCI_PROMOTION[promotionSymbol];
  if (promotionSymbol !== undefined && promotion === undefined) {
    throw new TypeError(`Unsupported UCI promotion symbol: ${promotionSymbol}.`);
  }
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(promotion === undefined ? {} : { promotion }),
  };
}

export function validatePublicReplay(
  initialFen: string,
  finalFen: string,
  plies: readonly PrivateSimulationTracePly[],
): void {
  let snapshot: PublicPositionAuthoritySnapshot =
    createStandardChessPositionSnapshot(initialFen);
  if (snapshot.fen !== initialFen) {
    throw new TypeError("trace.initialFen must be canonical.");
  }
  const history: ChessMove[] = [];
  for (const [index, ply] of plies.entries()) {
    const path = `trace.plies[${String(index)}]`;
    if (snapshot.fen !== ply.fenBefore) {
      throw new TypeError(`${path}.fenBefore does not match authority replay.`);
    }
    const ordinaryMoves = publicAuthorityLegalMoves(snapshot);
    const ordinaryUci = ordinaryMoves.map(canonicalMoveUci);
    if (!sameStringSet(ply.ordinaryLegalMoves, ordinaryUci)) {
      throw new TypeError(
        `${path}.ordinaryLegalMoves is not the complete authority-legal set.`,
      );
    }
    const position: PositionView = {
      fen: snapshot.fen,
      turn: ply.color,
      ply: index,
      history: [...history],
    };
    const evaluatorRequest = createEvaluatorTurnConstraintRequest(
      position,
      ordinaryMoves,
    );
    const constraint = ply.publicEvaluatorConstraint;
    if (
      constraint !== null
      && (
        constraint.policyId !== evaluatorRequest.policyId
        || constraint.positionKey !== evaluatorRequest.positionKey
      )
    ) {
      throw new TypeError(
        `${path}.publicEvaluatorConstraint does not match the public position.`,
      );
    }
    const transition = advancePublicPositionAuthority(
      snapshot,
      commandFromUci(ply.move.uci),
    );
    if (
      transition.position.authorityId !== "standard-chess/v1"
      || canonicalMoveUci(transition.move) !== ply.move.uci
      || transition.move.san !== ply.move.san
    ) {
      throw new TypeError(`${path}.move does not match authority replay.`);
    }
    if (transition.position.fen !== ply.fenAfter) {
      throw new TypeError(`${path}.fenAfter does not match authority replay.`);
    }
    history.push(transition.move);
    snapshot = transition.position;
  }
  if (snapshot.fen !== finalFen) {
    throw new TypeError("trace.finalFen does not match authority replay.");
  }
}
