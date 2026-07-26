import type { PlayerColor } from "@drawbackengine/shared";
import type { ChessMove, PieceType } from "./types.js";

export interface BoardPiece {
  readonly color: PlayerColor;
  readonly type: PieceType;
  readonly square: string;
}

interface Coordinates {
  readonly file: number;
  readonly rank: number;
}

const PIECES: Readonly<Record<string, PieceType>> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

function coordinates(square: string): Coordinates {
  if (!/^[a-h][1-8]$/u.test(square)) {
    throw new RangeError(`Invalid chess square: ${square}.`);
  }
  return {
    file: square.charCodeAt(0) - 96,
    rank: Number(square[1]),
  };
}

function squareAt(file: number, rank: number): string | null {
  if (file < 1 || file > 8 || rank < 1 || rank > 8) {
    return null;
  }
  return `${String.fromCharCode(96 + file)}${String(rank)}`;
}

export function parseFenPieces(fen: string): readonly BoardPiece[] {
  const placement = fen.split(/\s+/u)[0];
  if (placement === undefined) {
    throw new RangeError("FEN must include a piece-placement field.");
  }
  const rows = placement.split("/");
  if (rows.length !== 8) {
    throw new RangeError("FEN piece placement must contain eight ranks.");
  }
  const pieces: BoardPiece[] = [];
  rows.forEach((row, rowIndex) => {
    let file = 1;
    for (const symbol of row) {
      if (/^[1-8]$/u.test(symbol)) {
        file += Number(symbol);
        continue;
      }
      const type = PIECES[symbol.toLowerCase()];
      if (type === undefined || file > 8) {
        throw new RangeError(`Invalid FEN piece-placement symbol: ${symbol}.`);
      }
      pieces.push({
        color: symbol === symbol.toUpperCase() ? "white" : "black",
        type,
        square: squareAt(file, 8 - rowIndex) ?? "",
      });
      file += 1;
    }
    if (file !== 9) {
      throw new RangeError(`FEN rank ${String(8 - rowIndex)} does not contain eight files.`);
    }
  });
  return Object.freeze(pieces);
}

export function areAdjacent(left: string, right: string): boolean {
  const first = coordinates(left);
  const second = coordinates(right);
  return Math.max(
    Math.abs(first.file - second.file),
    Math.abs(first.rank - second.rank),
  ) === 1;
}

function hasPieceAt(
  piecesBySquare: ReadonlyMap<string, BoardPiece>,
  file: number,
  rank: number,
  color: PlayerColor,
  types: readonly PieceType[],
): boolean {
  const square = squareAt(file, rank);
  if (square === null) {
    return false;
  }
  const piece = piecesBySquare.get(square);
  return piece?.color === color && types.includes(piece.type);
}

function rayAttacked(
  piecesBySquare: ReadonlyMap<string, BoardPiece>,
  origin: Coordinates,
  color: PlayerColor,
  directions: readonly (readonly [number, number])[],
  attackers: readonly PieceType[],
): boolean {
  for (const [fileDelta, rankDelta] of directions) {
    let file = origin.file + fileDelta;
    let rank = origin.rank + rankDelta;
    while (squareAt(file, rank) !== null) {
      const piece = piecesBySquare.get(squareAt(file, rank) ?? "");
      if (piece !== undefined) {
        if (piece.color === color && attackers.includes(piece.type)) {
          return true;
        }
        break;
      }
      file += fileDelta;
      rank += rankDelta;
    }
  }
  return false;
}

function isSquareAttackedByPieces(
  pieces: readonly BoardPiece[],
  square: string,
  byColor: PlayerColor,
): boolean {
  const piecesBySquare = new Map(pieces.map((piece) => [piece.square, piece]));
  const target = coordinates(square);
  const pawnOriginRank = target.rank + (byColor === "white" ? -1 : 1);
  if (
    hasPieceAt(
      piecesBySquare,
      target.file - 1,
      pawnOriginRank,
      byColor,
      ["pawn"],
    ) ||
    hasPieceAt(
      piecesBySquare,
      target.file + 1,
      pawnOriginRank,
      byColor,
      ["pawn"],
    )
  ) {
    return true;
  }

  const knightOffsets: readonly (readonly [number, number])[] = [
    [-2, -1],
    [-2, 1],
    [-1, -2],
    [-1, 2],
    [1, -2],
    [1, 2],
    [2, -1],
    [2, 1],
  ];
  if (knightOffsets.some(([file, rank]) =>
    hasPieceAt(
      piecesBySquare,
      target.file + file,
      target.rank + rank,
      byColor,
      ["knight"],
    ),
  )) {
    return true;
  }

  const adjacentOffsets: readonly (readonly [number, number])[] = [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 0],
    [1, 1],
  ];
  if (adjacentOffsets.some(([file, rank]) =>
    hasPieceAt(
      piecesBySquare,
      target.file + file,
      target.rank + rank,
      byColor,
      ["king"],
    ),
  )) {
    return true;
  }

  return rayAttacked(
    piecesBySquare,
    target,
    byColor,
    [[-1, -1], [-1, 1], [1, -1], [1, 1]],
    ["bishop", "queen"],
  ) || rayAttacked(
    piecesBySquare,
    target,
    byColor,
    [[-1, 0], [1, 0], [0, -1], [0, 1]],
    ["rook", "queen"],
  );
}

export function isSquareAttacked(
  fen: string,
  square: string,
  byColor: PlayerColor,
): boolean {
  return isSquareAttackedByPieces(parseFenPieces(fen), square, byColor);
}

function enPassantCapturedSquare(move: ChessMove): string {
  const file = move.to[0];
  const rank = move.from[1];
  if (file === undefined || rank === undefined) {
    throw new RangeError("En-passant move has malformed endpoints.");
  }
  return `${file}${rank}`;
}

function castleRookMovement(
  move: ChessMove,
): readonly [string, string] | null {
  if (!move.flags.includes("castle")) {
    return null;
  }
  const movements: Readonly<Record<string, readonly [string, string]>> = {
    e1g1: ["h1", "f1"],
    e1c1: ["a1", "d1"],
    e8g8: ["h8", "f8"],
    e8c8: ["a8", "d8"],
  };
  const movement = movements[`${move.from}${move.to}`];
  if (movement === undefined) {
    throw new RangeError(
      `Cannot infer secondary rook movement for castling move ${move.from}-${move.to}.`,
    );
  }
  return movement;
}

export function projectPiecesAfterMove(
  fen: string,
  move: ChessMove,
): readonly BoardPiece[] {
  const pieces = parseFenPieces(fen);
  const mover = pieces.find(
    (piece) =>
      piece.square === move.from &&
      piece.color === move.color &&
      piece.type === move.piece,
  );
  if (mover === undefined) {
    throw new RangeError(
      `FEN does not contain the ${move.color} ${move.piece} on ${move.from}.`,
    );
  }
  const capturedSquare = move.flags.split(",").includes("en-passant")
    ? enPassantCapturedSquare(move)
    : move.to;
  const rookMovement = castleRookMovement(move);
  if (
    rookMovement !== null &&
    !pieces.some(
      (piece) =>
        piece.square === rookMovement[0] &&
        piece.color === move.color &&
        piece.type === "rook",
    )
  ) {
    throw new RangeError(
      `FEN does not contain the castling rook on ${rookMovement[0]}.`,
    );
  }
  const projected = pieces.filter(
    (piece) =>
      piece.square !== move.from &&
      (!isCaptureProjection(move) || piece.square !== capturedSquare) &&
      (rookMovement === null || piece.square !== rookMovement[0]),
  );
  projected.push({
    color: move.color,
    type: move.promotion ?? move.piece,
    square: move.to,
  });
  if (rookMovement !== null) {
    projected.push({
      color: move.color,
      type: "rook",
      square: rookMovement[1],
    });
  }
  return Object.freeze(projected);
}

function isCaptureProjection(move: ChessMove): boolean {
  return move.captured !== undefined ||
    move.flags.split(",").some(
      (flag) => flag === "capture" || flag === "en-passant",
    );
}

export function isDestinationDefendedAfterMove(
  fen: string,
  move: ChessMove,
): boolean {
  return isSquareAttackedByPieces(
    projectPiecesAfterMove(fen, move),
    move.to,
    move.color,
  );
}

export function isSquareAttackedAfterMove(
  fen: string,
  move: ChessMove,
  square: string,
  byColor: PlayerColor,
): boolean {
  return isSquareAttackedByPieces(
    projectPiecesAfterMove(fen, move),
    square,
    byColor,
  );
}

export function isSquareAttackedByQueen(
  fen: string,
  square: string,
  byColor: PlayerColor,
): boolean {
  const pieces = parseFenPieces(fen);
  const piecesBySquare = new Map(pieces.map((piece) => [piece.square, piece]));
  const target = coordinates(square);
  return rayAttacked(
    piecesBySquare,
    target,
    byColor,
    [[-1, -1], [-1, 1], [1, -1], [1, 1]],
    ["queen"],
  ) || rayAttacked(
    piecesBySquare,
    target,
    byColor,
    [[-1, 0], [1, 0], [0, -1], [0, 1]],
    ["queen"],
  );
}

export function isInCheck(fen: string, color: PlayerColor): boolean {
  const king = parseFenPieces(fen).find(
    (piece) => piece.color === color && piece.type === "king",
  );
  if (king === undefined) {
    throw new RangeError(`FEN does not contain a ${color} king.`);
  }
  return isSquareAttacked(fen, king.square, color === "white" ? "black" : "white");
}
