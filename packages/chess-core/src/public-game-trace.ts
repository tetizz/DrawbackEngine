import type {
  ChessMove,
  PositionAuthorityId,
  PositionView,
  PromotionPiece,
} from "@drawbackengine/drawback-engine";
import type { MoveCommand } from "./game-session.js";
import {
  advancePublicPositionAuthority,
  validatePublicPositionAuthoritySnapshot,
  type PublicPositionAuthoritySnapshot,
} from "./public-position-authority.js";

const TRACE_BRAND: unique symbol = Symbol("PublicGameTrace");

export interface PublicGameTrace {
  readonly format: "drawbackengine-public-game-trace";
  readonly version: 1;
  readonly authorityId: PositionAuthorityId;
  readonly ply: number;
  readonly [TRACE_BRAND]: true;
}

export interface PublicGameTraceSnapshot {
  readonly origin: PublicPositionAuthoritySnapshot;
  readonly current: PublicPositionAuthoritySnapshot;
  readonly moves: readonly ChessMove[];
}

type PublicGameTraceData = PublicGameTraceSnapshot;

const traceData = new WeakMap<object, PublicGameTraceData>();

export class PublicGameTraceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublicGameTraceError";
  }
}

/**
 * Declares a validated public authority snapshot as this game's explicit
 * origin. A custom starting FEN is safe here because it remains permanently
 * bound as the origin of the opaque trace.
 */
export function createPublicGameTrace(
  originInput: unknown,
): PublicGameTrace {
  const origin = validatePublicPositionAuthoritySnapshot(originInput);
  return mintTrace(origin, origin, []);
}

/**
 * Advances an authenticated trace through exactly one authority-legal move.
 */
export function advancePublicGameTrace(
  trace: PublicGameTrace,
  command: MoveCommand,
): PublicGameTrace {
  const data = requiredTraceData(trace);
  const transition = advancePublicPositionAuthority(data.current, command);
  return mintTrace(
    data.origin,
    transition.position,
    [...data.moves, transition.move],
  );
}

/**
 * Reconstructs a trace from a declared origin and complete public move list.
 * Every supplied move must exactly match authority-generated public metadata,
 * and the replayed final snapshot must equal expectedCurrentInput.
 */
export function replayPublicGameTrace(
  originInput: unknown,
  movesInput: readonly unknown[],
  expectedCurrentInput: unknown,
): PublicGameTrace {
  const origin = validatePublicPositionAuthoritySnapshot(originInput);
  const expectedCurrent =
    validatePublicPositionAuthoritySnapshot(expectedCurrentInput);
  if (origin.authorityId !== expectedCurrent.authorityId) {
    throw new PublicGameTraceError(
      "Public game trace origin and current authority IDs differ.",
    );
  }
  let trace = createPublicGameTrace(origin);
  for (const [index, input] of movesInput.entries()) {
    const supplied = parseSuppliedMove(input, index);
    const data = requiredTraceData(trace);
    const transition = advancePublicPositionAuthority(
      data.current,
      supplied.command,
    );
    if (!sameMoveDetails(supplied.properties, transition.move)) {
      throw new PublicGameTraceError(
        `Public game trace move ${String(index)} does not match authority replay.`,
      );
    }
    trace = mintTrace(
      data.origin,
      transition.position,
      [...data.moves, transition.move],
    );
  }
  const replayed = requiredTraceData(trace).current;
  if (!sameSnapshot(replayed, expectedCurrent)) {
    throw new PublicGameTraceError(
      "Public game trace replay does not match the expected current snapshot.",
    );
  }
  return trace;
}

export function inspectPublicGameTrace(
  trace: PublicGameTrace,
): PublicGameTraceSnapshot {
  const data = requiredTraceData(trace);
  return Object.freeze({
    origin: immutableSnapshot(data.origin),
    current: immutableSnapshot(data.current),
    moves: immutableMoves(data.moves),
  });
}

export function publicGameTraceView(trace: PublicGameTrace): PositionView {
  const data = requiredTraceData(trace);
  return positionView(data.current, data.moves);
}

function mintTrace(
  origin: PublicPositionAuthoritySnapshot,
  current: PublicPositionAuthoritySnapshot,
  moves: readonly ChessMove[],
): PublicGameTrace {
  const trace = Object.freeze({
    format: "drawbackengine-public-game-trace" as const,
    version: 1 as const,
    authorityId: origin.authorityId,
    ply: moves.length,
    [TRACE_BRAND]: true as const,
  });
  traceData.set(trace, Object.freeze({
    origin: immutableSnapshot(origin),
    current: immutableSnapshot(current),
    moves: immutableMoves(moves),
  }));
  return trace;
}

function requiredTraceData(trace: PublicGameTrace): PublicGameTraceData {
  const data = traceData.get(trace);
  if (data === undefined) {
    throw new PublicGameTraceError(
      "Public game trace was not minted by the public position authority.",
    );
  }
  return data;
}

function positionView(
  snapshot: PublicPositionAuthoritySnapshot,
  moves: readonly ChessMove[],
): PositionView {
  const activeColor = snapshot.fen.split(/\s+/u)[1];
  if (activeColor !== "w" && activeColor !== "b") {
    throw new PublicGameTraceError(
      "Public authority snapshot has no valid active color.",
    );
  }
  return Object.freeze({
    fen: snapshot.fen,
    turn: activeColor === "w" ? "white" : "black",
    ply: moves.length,
    history: immutableMoves(moves),
  });
}

function immutableMoves(moves: readonly ChessMove[]): readonly ChessMove[] {
  return Object.freeze(moves.map((move) =>
    Object.freeze(structuredClone(move))
  ));
}

function immutableSnapshot(
  snapshot: PublicPositionAuthoritySnapshot,
): PublicPositionAuthoritySnapshot {
  const copy = structuredClone(snapshot);
  freezeRecursively(copy);
  return copy;
}

function freezeRecursively(value: object): void {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const propertyValue: unknown =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
    if (typeof propertyValue === "object" && propertyValue !== null) {
      freezeRecursively(propertyValue);
    }
  }
  Object.freeze(value);
}

interface ParsedSuppliedMove {
  readonly command: MoveCommand;
  readonly properties: Readonly<Record<string, unknown>>;
}

function parseSuppliedMove(input: unknown, index: number): ParsedSuppliedMove {
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new PublicGameTraceError(
      `Public game trace move ${String(index)} must be a plain object.`,
    );
  }
  const keys = Reflect.ownKeys(input);
  const allowed = new Set([
    "captured",
    "color",
    "flags",
    "from",
    "piece",
    "promotion",
    "san",
    "to",
  ]);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || !["color", "flags", "from", "piece", "san", "to"].every(
      (key) => keys.includes(key),
    )
  ) {
    throw new PublicGameTraceError(
      `Public game trace move ${String(index)} has invalid keys.`,
    );
  }
  const properties: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new PublicGameTraceError(
        `Public game trace move ${String(index)} has a symbol key.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw new PublicGameTraceError(
        `Public game trace move ${String(index)}.${key} must be an enumerable data property.`,
      );
    }
    properties[key] = descriptor.value;
  }
  const from = properties["from"];
  const to = properties["to"];
  if (typeof from !== "string" || typeof to !== "string") {
    throw new PublicGameTraceError(
      `Public game trace move ${String(index)} has invalid squares.`,
    );
  }
  const promotion = properties["promotion"];
  if (promotion !== undefined && !isPromotionPiece(promotion)) {
    throw new PublicGameTraceError(
      `Public game trace move ${String(index)} has an invalid promotion.`,
    );
  }
  return {
    command: {
      from,
      to,
      ...(promotion === undefined ? {} : { promotion }),
    },
    properties: Object.freeze(properties),
  };
}

function sameMoveDetails(
  supplied: Readonly<Record<string, unknown>>,
  generated: ChessMove,
): boolean {
  const generatedProperties = Object.entries(generated);
  const suppliedKeys = Object.keys(supplied);
  return (
    suppliedKeys.length === generatedProperties.length
    && generatedProperties.every(
      ([key, value]) =>
        Object.hasOwn(supplied, key) && supplied[key] === value,
    )
  );
}

function sameSnapshot(
  left: PublicPositionAuthoritySnapshot,
  right: PublicPositionAuthoritySnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPromotionPiece(value: unknown): value is PromotionPiece {
  return (
    value === "bishop"
    || value === "knight"
    || value === "queen"
    || value === "rook"
  );
}
