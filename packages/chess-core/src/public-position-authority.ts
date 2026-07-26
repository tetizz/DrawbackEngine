import { Chess } from "chess.js";
import type {
  ChessMove,
  PositionAuthorityId,
} from "@drawbackengine/drawback-engine";
import {
  CapturableKingPosition,
  type CapturableKingPositionSnapshot,
} from "./capturable-king-position.js";
import type { MoveCommand } from "./game-session.js";
import { sameMove, toChessMove } from "./move-adapter.js";

export interface StandardChessPositionSnapshot {
  readonly format: "drawbacktrainer-public-position";
  readonly version: 1;
  readonly authorityId: "standard-chess/v1";
  readonly fen: string;
}

export type PublicPositionAuthoritySnapshot =
  | StandardChessPositionSnapshot
  | CapturableKingPositionSnapshot;

export interface PublicAuthorityTransition {
  readonly move: ChessMove;
  readonly position: PublicPositionAuthoritySnapshot;
}

export function createStandardChessPositionSnapshot(
  fen: string,
): StandardChessPositionSnapshot {
  const chess = new Chess(fen);
  return Object.freeze({
    format: "drawbacktrainer-public-position",
    version: 1,
    authorityId: "standard-chess/v1",
    fen: chess.fen(),
  });
}

export function validatePublicPositionAuthoritySnapshot(
  input: unknown,
): PublicPositionAuthoritySnapshot {
  if (!isRecord(input)) {
    throw new TypeError("Public position authority snapshot must be an object.");
  }
  if (input["authorityId"] === "capturable-king/v1") {
    return CapturableKingPosition.fromSnapshot(input).snapshot();
  }
  if (input["authorityId"] !== "standard-chess/v1") {
    throw new TypeError("Public position authority snapshot has an unknown authority.");
  }
  const keys = Object.keys(input);
  const expected = ["authorityId", "fen", "format", "version"];
  if (
    keys.length !== expected.length
    || expected.some((key) => !Object.hasOwn(input, key))
  ) {
    throw new TypeError("Standard chess position snapshot keys are invalid.");
  }
  if (
    input["format"] !== "drawbacktrainer-public-position"
    || input["version"] !== 1
    || typeof input["fen"] !== "string"
  ) {
    throw new TypeError("Standard chess position snapshot header is invalid.");
  }
  const snapshot = createStandardChessPositionSnapshot(input["fen"]);
  if (snapshot.fen !== input["fen"]) {
    throw new TypeError("Standard chess position snapshot FEN is not canonical.");
  }
  return snapshot;
}

export function publicAuthorityLegalMoves(
  snapshotInput: unknown,
): readonly ChessMove[] {
  const snapshot = validatePublicPositionAuthoritySnapshot(snapshotInput);
  if (snapshot.authorityId === "capturable-king/v1") {
    return Object.freeze(
      CapturableKingPosition.fromSnapshot(snapshot)
        .legalMoves()
        .map(immutableMove),
    );
  }
  const chess = new Chess(snapshot.fen);
  return Object.freeze(chess.moves({ verbose: true }).map((move) =>
    immutableMove(toChessMove(move))
  ));
}

export function advancePublicPositionAuthority(
  snapshotInput: unknown,
  command: MoveCommand,
): PublicAuthorityTransition {
  const snapshot = validatePublicPositionAuthoritySnapshot(snapshotInput);
  if (snapshot.authorityId === "capturable-king/v1") {
    const position = CapturableKingPosition.fromSnapshot(snapshot);
    const result = position.move(command);
    if (result === null) {
      throw new RangeError("Move is not legal under capturable-king/v1.");
    }
    return Object.freeze({
      move: immutableMove(result.move),
      position: position.snapshot(),
    });
  }

  const chess = new Chess(snapshot.fen);
  const legal = chess.moves({ verbose: true }).map(toChessMove);
  const requested = legal.find((move) => sameMove(move, command));
  if (requested === undefined) {
    throw new RangeError("Move is not legal under standard-chess/v1.");
  }
  const applied = chess.move({
    from: requested.from,
    to: requested.to,
    ...(requested.promotion === undefined
      ? {}
      : { promotion: requested.promotion.charAt(0) }),
  });
  return Object.freeze({
    move: immutableMove(toChessMove(applied)),
    position: createStandardChessPositionSnapshot(chess.fen()),
  });
}

export function authorityIdOf(
  snapshotInput: unknown,
): PositionAuthorityId {
  return validatePublicPositionAuthoritySnapshot(snapshotInput).authorityId;
}

function immutableMove(move: ChessMove): ChessMove {
  return Object.freeze(structuredClone(move));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
