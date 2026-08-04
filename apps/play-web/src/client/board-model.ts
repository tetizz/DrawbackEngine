import type { CSSProperties } from "react";
import type { PositionDataType } from "react-chessboard";
import type {
  PlayerPlayAction,
  PlayerPlayObservationV1,
} from "@drawbackengine/simulation-arena";

const PIECE_SYMBOL = Object.freeze({
  pawn: "P",
  knight: "N",
  bishop: "B",
  rook: "R",
  queen: "Q",
  king: "K",
} as const);

export function boardPosition(
  observation: PlayerPlayObservationV1,
): PositionDataType {
  const position: PositionDataType = {};
  for (const square of observation.board) {
    if (square.occupant !== null) {
      position[square.square] = {
        pieceType:
          `${square.occupant.color === "white" ? "w" : "b"}${PIECE_SYMBOL[square.occupant.type]}`,
      };
    }
  }
  return position;
}

export function boardPositionAfterAction(
  observation: PlayerPlayObservationV1,
  action: PlayerPlayAction,
): PositionDataType {
  const currentPosition = boardPosition(observation);
  const movingPiece = currentPosition[action.from];
  if (movingPiece === undefined) {
    return currentPosition;
  }

  const removedSquares = new Set([action.from, action.to]);
  const targetWasEmpty = currentPosition[action.to] === undefined;
  const fromFile = action.from.charAt(0);
  const fromRank = action.from.charAt(1);
  const toFile = action.to.charAt(0);
  const toRank = action.to.charAt(1);
  if (
    movingPiece.pieceType.endsWith("P")
    && fromFile !== toFile
    && targetWasEmpty
    && fromRank !== ""
    && toFile !== ""
  ) {
    removedSquares.add(`${toFile}${fromRank}`);
  }

  let rookMove: { readonly from: string; readonly to: string } | null = null;
  if (
    movingPiece.pieceType.endsWith("K")
    && fromRank === toRank
    && Math.abs(fromFile.charCodeAt(0) - toFile.charCodeAt(0)) === 2
  ) {
    const kingSide = toFile.charCodeAt(0) > fromFile.charCodeAt(0);
    const rookFrom = `${kingSide ? "h" : "a"}${fromRank}`;
    const rookTo = `${kingSide ? "f" : "d"}${fromRank}`;
    if (currentPosition[rookFrom] !== undefined) {
      removedSquares.add(rookFrom);
      rookMove = { from: rookFrom, to: rookTo };
    }
  }

  const position: PositionDataType = {};
  for (const [square, piece] of Object.entries(currentPosition)) {
    if (!removedSquares.has(square)) {
      position[square] = piece;
    }
  }
  if (rookMove !== null) {
    const rook = currentPosition[rookMove.from];
    if (rook !== undefined) {
      position[rookMove.to] = rook;
    }
  }
  position[action.to] = action.promotion === undefined
    ? movingPiece
    : {
        pieceType:
          `${movingPiece.pieceType.charAt(0)}${PIECE_SYMBOL[action.promotion]}`,
      };
  return position;
}

export function actionsFrom(
  actions: readonly PlayerPlayAction[],
  square: string,
): readonly PlayerPlayAction[] {
  return actions.filter((action) => action.from === square);
}

export function actionsTo(
  actions: readonly PlayerPlayAction[],
  from: string,
  to: string,
): readonly PlayerPlayAction[] {
  return actions.filter((action) => action.from === from && action.to === to);
}

export function boardSquareStyles(
  observation: PlayerPlayObservationV1,
  selectedSquare: string | null,
): Record<string, CSSProperties> {
  const styles: Record<string, CSSProperties> = {};
  if (observation.lastMove !== null) {
    styles[observation.lastMove.from] = {
      background: "rgba(194, 255, 82, 0.34)",
    };
    styles[observation.lastMove.to] = {
      background: "rgba(194, 255, 82, 0.48)",
    };
  }
  if (selectedSquare !== null) {
    styles[selectedSquare] = {
      ...styles[selectedSquare],
      boxShadow: "inset 0 0 0 4px #d7ff60",
    };
    for (const action of actionsFrom(observation.actions, selectedSquare)) {
      styles[action.to] = {
        ...styles[action.to],
        background:
          "radial-gradient(circle, rgba(13, 25, 24, 0.52) 0 17%, transparent 19%)",
      };
    }
  }
  return styles;
}
