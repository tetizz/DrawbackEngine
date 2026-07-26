import type { RandomSource } from "@drawbackengine/shared";
import type {
  ChessMove,
  DrawbackRule,
  PieceType,
} from "../types.js";
import { isCapture } from "./common.js";

const FILES = "abcdefgh";
const PIECE_TYPES: readonly PieceType[] = [
  "pawn",
  "knight",
  "bishop",
  "rook",
  "queen",
  "king",
];

function fileAt(index: number): string {
  const file = FILES[index];
  if (file === undefined) {
    throw new RangeError(`Invalid file index: ${String(index)}.`);
  }
  return file;
}

export interface HiddenSquareParameters {
  readonly square: string;
}

export interface HiddenRankParameters {
  readonly rank: number;
}

export interface HiddenPieceTypeParameters {
  readonly seed: number;
}

export interface ParameterizedRuleState {
  readonly movesApplied: number;
}

function squareCoordinates(square: string): readonly [number, number] {
  if (!/^[a-h][1-8]$/.test(square)) {
    throw new RangeError(`Invalid chess square: ${square}.`);
  }
  return [FILES.indexOf(square[0] ?? ""), Number(square[1]) - 1];
}

function traversedPrimarySquares(move: ChessMove): readonly string[] {
  const [fromFile, fromRank] = squareCoordinates(move.from);
  const [toFile, toRank] = squareCoordinates(move.to);
  const fileDelta = toFile - fromFile;
  const rankDelta = toRank - fromRank;
  const distance = Math.max(Math.abs(fileDelta), Math.abs(rankDelta));
  const isLine =
    fileDelta === 0 ||
    rankDelta === 0 ||
    Math.abs(fileDelta) === Math.abs(rankDelta);
  if (!isLine || distance === 0) {
    return [move.to];
  }
  const fileStep = Math.sign(fileDelta);
  const rankStep = Math.sign(rankDelta);
  return Array.from({ length: distance }, (_, index) => {
    const step = index + 1;
    return `${fileAt(fromFile + fileStep * step)}${String(fromRank + rankStep * step + 1)}`;
  });
}

export function defineHiddenSquareRestriction(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}): DrawbackRule<ParameterizedRuleState, HiddenSquareParameters> {
  return {
    ...configuration,
    verification: "implemented-unverified",
    generateParameters: (rng) => ({
      square: `${fileAt(rng.integer(8))}${String(rng.integer(8) + 1)}`,
    }),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (context, moves) =>
      moves.filter(
        (move) => !traversedPrimarySquares(move).includes(context.parameters.square),
      ),
    applyMove: (context) => ({
      movesApplied: context.state.movesApplied + 1,
    }),
    checkStartOfTurnLoss: () => null,
    describeTurn: (context) => [
      `Forbidden square: ${context.parameters.square}`,
    ],
  };
}

export function defineHiddenCaptureRankRestriction(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}): DrawbackRule<ParameterizedRuleState, HiddenRankParameters> {
  return {
    ...configuration,
    verification: "implemented-unverified",
    generateParameters: (rng) => ({ rank: rng.integer(8) + 1 }),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (context, moves) =>
      moves.filter(
        (move) =>
          !isCapture(move) || Number(move.to[1]) !== context.parameters.rank,
      ),
    applyMove: (context) => ({
      movesApplied: context.state.movesApplied + 1,
    }),
    checkStartOfTurnLoss: () => null,
    describeTurn: (context) => [
      `Forbidden capture rank: ${String(context.parameters.rank)}`,
    ],
  };
}

function mixSeed(seed: number, turnIndex: number): number {
  let value = (seed + Math.imul(turnIndex + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

export function hiddenPieceTypeForTurn(
  parameters: HiddenPieceTypeParameters,
  state: ParameterizedRuleState,
): PieceType {
  const selected = PIECE_TYPES[mixSeed(parameters.seed, state.movesApplied) % PIECE_TYPES.length];
  if (selected === undefined) {
    throw new Error("Hidden piece-type selection invariant failed.");
  }
  return selected;
}

export function defineRerandomizedForbiddenMoverType(configuration: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}): DrawbackRule<ParameterizedRuleState, HiddenPieceTypeParameters> {
  return {
    ...configuration,
    verification: "implemented-unverified",
    generateParameters: (rng: RandomSource) => ({ seed: rng.integer(0x1_0000_0000) }),
    initialize: () => ({ movesApplied: 0 }),
    filterLegalMoves: (context, moves) => {
      const forbidden = hiddenPieceTypeForTurn(context.parameters, context.state);
      return moves.filter((move) => move.piece !== forbidden);
    },
    applyMove: (context) => ({
      movesApplied: context.state.movesApplied + 1,
    }),
    checkStartOfTurnLoss: () => null,
    describeTurn: (context) => [
      `Forbidden mover: ${hiddenPieceTypeForTurn(
        context.parameters,
        context.state,
      )}`,
    ],
  };
}
