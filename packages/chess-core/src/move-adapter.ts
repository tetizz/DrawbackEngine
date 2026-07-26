import type { Color, Move, PieceSymbol } from "chess.js";
import type {
  ChessMove,
  PieceType,
  PromotionPiece,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";

const PIECES: Readonly<Record<PieceSymbol, PieceType>> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export function playerColor(color: Color): PlayerColor {
  return color === "w" ? "white" : "black";
}

export function toChessMove(move: Move): ChessMove {
  const captured = move.captured === undefined ? {} : { captured: PIECES[move.captured] };
  const promotion =
    move.promotion === undefined
      ? {}
      : { promotion: PIECES[move.promotion] as PromotionPiece };
  return {
    from: move.from,
    to: move.to,
    color: playerColor(move.color),
    piece: PIECES[move.piece],
    ...captured,
    ...promotion,
    san: move.san,
    flags: [
      move.isCapture() || move.isEnPassant() ? "capture" : "quiet",
      move.isPromotion() ? "promotion" : "",
      move.isEnPassant() ? "en-passant" : "",
      move.isKingsideCastle() ? "kingside-castle" : "",
      move.isQueensideCastle() ? "queenside-castle" : "",
    ]
      .filter((flag) => flag.length > 0)
      .join(","),
  };
}

export function sameMove(
  candidate: Pick<ChessMove, "from" | "to" | "promotion">,
  move: Pick<ChessMove, "from" | "to" | "promotion">,
): boolean {
  return (
    candidate.from === move.from &&
    candidate.to === move.to &&
    candidate.promotion === move.promotion
  );
}
