import {
  unrestrictedRule,
  type ChessMove,
} from "@drawbackengine/drawback-engine";
import { Mulberry32, type PlayerColor } from "@drawbackengine/shared";
import { GameSession } from "./game-session.js";

export const MAX_COMPLETED_PGN_INPUT_BYTES = 1_048_576;
export const MAX_COMPLETED_PGN_PLIES = 600;

const TERMINAL_RESULT_TOKENS = new Set(["1-0", "0-1", "1/2-1/2"]);
const RESULT_TOKENS = new Set([...TERMINAL_RESULT_TOKENS, "*"]);

export class CompletedPgnParseError extends Error {
  public readonly ply: number;
  public readonly token: string | null;

  public constructor(message: string, ply: number, token: string | null) {
    super(message);
    this.name = "PgnParseError";
    this.ply = ply;
    this.token = token;
  }
}

export interface CompletedPgnReplayStep {
  readonly ply: number;
  readonly moveNumber: number;
  readonly color: PlayerColor;
  readonly san: string;
  readonly fenBefore: string;
  readonly fenAfter: string;
  readonly historyBefore: readonly ChessMove[];
  readonly ordinaryLegalMoves: readonly ChessMove[];
  readonly move: ChessMove;
}

export interface CompletedPgnReplay {
  readonly headers: ReadonlyMap<string, string>;
  readonly normalizedMainline: readonly string[];
  readonly initialFen: string;
  readonly finalFen: string;
  readonly steps: readonly CompletedPgnReplayStep[];
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  public constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  public get size(): number {
    return this.#values.size;
  }

  public entries(): MapIterator<[K, V]> {
    return this.#values.entries();
  }

  public forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  public get(key: K): V | undefined {
    return this.#values.get(key);
  }

  public has(key: K): boolean {
    return this.#values.has(key);
  }

  public keys(): MapIterator<K> {
    return this.#values.keys();
  }

  public values(): MapIterator<V> {
    return this.#values.values();
  }

  public [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

function immutableMove(move: ChessMove): ChessMove {
  return Object.freeze({ ...move });
}

function fullmoveNumber(fen: string): number {
  const value = fen.trim().split(/\s+/u)[5];
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Session produced a FEN with an invalid fullmove number: ${fen}`);
  }
  return parsed;
}

function pgnHeaders(pgn: string): ReadonlyMap<string, string> {
  const headers = new Map<string, string>();
  const headerPattern =
    /^\s*\[([A-Za-z0-9_]+)\s+"((?:\\.|[^"])*)"\]\s*$/u;
  for (const line of pgn.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[")) {
      continue;
    }
    const match = headerPattern.exec(line);
    if (match === null) {
      throw new CompletedPgnParseError(
        `Malformed PGN header: ${trimmed}`,
        0,
        null,
      );
    }
    const name = match[1];
    const rawValue = match[2];
    if (name === undefined || rawValue === undefined) {
      throw new CompletedPgnParseError(
        `Malformed PGN header: ${trimmed}`,
        0,
        null,
      );
    }
    headers.set(name, rawValue.replace(/\\(["\\])/gu, "$1"));
  }
  return headers;
}

function initialFenFromHeaders(
  headers: ReadonlyMap<string, string>,
): string | undefined {
  const setup = headers.get("SetUp");
  const fen = headers.get("FEN");
  if (setup === "1" && fen === undefined) {
    throw new CompletedPgnParseError(
      'PGN declares SetUp "1" without a FEN header.',
      0,
      null,
    );
  }
  return setup === "1" ? fen : undefined;
}

function stripHeaders(pgn: string): string {
  return pgn
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("["))
    .join("\n");
}

function stripCommentsAndVariations(text: string): string {
  let result = "";
  let braceDepth = 0;
  let variationDepth = 0;
  let lineComment = false;

  for (const character of text) {
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        result += " ";
      }
      continue;
    }
    if (braceDepth > 0) {
      if (character === "{") {
        braceDepth += 1;
      } else if (character === "}") {
        braceDepth -= 1;
      }
      continue;
    }
    if (variationDepth > 0) {
      if (character === "(") {
        variationDepth += 1;
      } else if (character === ")") {
        variationDepth -= 1;
      }
      continue;
    }
    if (character === ";") {
      lineComment = true;
    } else if (character === "{") {
      braceDepth = 1;
    } else if (character === "(") {
      variationDepth = 1;
    } else if (character === "}" || character === ")") {
      throw new CompletedPgnParseError(
        `Unexpected closing ${character === "}" ? "comment" : "variation"} marker.`,
        0,
        character,
      );
    } else {
      result += character;
    }
  }

  if (braceDepth > 0) {
    throw new CompletedPgnParseError(
      "Unterminated PGN comment.",
      0,
      null,
    );
  }
  if (variationDepth > 0) {
    throw new CompletedPgnParseError(
      "Unterminated PGN variation.",
      0,
      null,
    );
  }
  return result;
}

export function tokenizeCompletedPgn(pgn: string): readonly string[] {
  const body = stripCommentsAndVariations(stripHeaders(pgn));
  const moves: string[] = [];
  for (const rawToken of body.split(/\s+/u)) {
    let token = rawToken.trim();
    if (token.length === 0 || /^\$\d+$/u.test(token)) {
      continue;
    }
    token = token.replace(/^\d+\.(?:\.\.)?/u, "");
    if (token.length === 0 || RESULT_TOKENS.has(token)) {
      continue;
    }
    moves.push(token);
  }
  return Object.freeze(moves);
}

function movetextResult(pgn: string): string | undefined {
  const body = stripCommentsAndVariations(stripHeaders(pgn));
  const tokens = body
    .split(/\s+/u)
    .map((rawToken) => rawToken.trim().replace(/^\d+\.(?:\.\.)?/u, ""))
    .filter((token) => token.length > 0 && !/^\$\d+$/u.test(token));
  const finalToken = tokens.at(-1);
  return finalToken !== undefined && RESULT_TOKENS.has(finalToken)
    ? finalToken
    : undefined;
}

function normalizedSan(san: string): string {
  return san.replaceAll("0", "O").replace(/[!?]+$/u, "");
}

function findMove(
  token: string,
  moves: readonly ChessMove[],
): ChessMove | undefined {
  const normalized = normalizedSan(token);
  return moves.find((move) => normalizedSan(move.san) === normalized);
}

function createReplaySession(fen?: string) {
  return new GameSession(
    { white: unrestrictedRule, black: unrestrictedRule },
    new Mulberry32(0x50474e),
    fen,
  );
}

export function replayCompletedPgn(pgn: string): CompletedPgnReplay {
  const inputBytes = new TextEncoder().encode(pgn).byteLength;
  if (inputBytes > MAX_COMPLETED_PGN_INPUT_BYTES) {
    throw new CompletedPgnParseError(
      `PGN exceeds the ${String(MAX_COMPLETED_PGN_INPUT_BYTES)} byte analysis limit.`,
      0,
      null,
    );
  }
  const headers = pgnHeaders(pgn);
  const tokens = tokenizeCompletedPgn(pgn);
  if (tokens.length === 0) {
    throw new CompletedPgnParseError(
      "Paste a PGN containing at least one move.",
      0,
      null,
    );
  }
  if (tokens.length > MAX_COMPLETED_PGN_PLIES) {
    throw new CompletedPgnParseError(
      `PGN exceeds the ${String(MAX_COMPLETED_PGN_PLIES)} ply analysis limit.`,
      MAX_COMPLETED_PGN_PLIES + 1,
      tokens[MAX_COMPLETED_PGN_PLIES] ?? null,
    );
  }
  const declaredResult = headers.get("Result");
  if (
    declaredResult === undefined ||
    !TERMINAL_RESULT_TOKENS.has(declaredResult) ||
    movetextResult(pgn) !== declaredResult
  ) {
    throw new CompletedPgnParseError(
      'Post-game analysis requires matching terminal PGN header and movetext results: "1-0", "0-1", or "1/2-1/2".',
      0,
      null,
    );
  }

  let session: ReturnType<typeof createReplaySession>;
  try {
    session = createReplaySession(initialFenFromHeaders(headers));
  } catch (error) {
    throw new CompletedPgnParseError(
      `Invalid PGN starting position: ${error instanceof Error ? error.message : String(error)}`,
      0,
      null,
    );
  }
  const initialFen = session.fen;
  const steps: CompletedPgnReplayStep[] = [];
  for (const [index, token] of tokens.entries()) {
    const ordinaryLegalMoves = session.ordinaryLegalMoves();
    const move = findMove(token, ordinaryLegalMoves);
    if (move === undefined) {
      throw new CompletedPgnParseError(
        `Move ${String(index + 1)} (${token}) is not legal in the current position.`,
        index + 1,
        token,
      );
    }
    const historyBefore = session.history();
    const fenBefore = session.fen;
    const color = session.turn;
    const outcome = session.move({
      from: move.from,
      to: move.to,
      ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
    });
    if (!outcome.ok) {
      throw new CompletedPgnParseError(
        outcome.message,
        index + 1,
        token,
      );
    }
    const immutableHistory = Object.freeze(historyBefore.map(immutableMove));
    const immutableLegalMoves = Object.freeze(
      ordinaryLegalMoves.map(immutableMove),
    );
    const immutableObservedMove = immutableMove(outcome.observation.move);
    steps.push(Object.freeze({
      ply: index + 1,
      moveNumber: fullmoveNumber(fenBefore),
      color,
      san: immutableObservedMove.san,
      fenBefore,
      fenAfter: session.fen,
      historyBefore: immutableHistory,
      ordinaryLegalMoves: immutableLegalMoves,
      move: immutableObservedMove,
    }));
  }

  return Object.freeze({
    headers: new ImmutableMap(headers),
    normalizedMainline: Object.freeze([...tokens]),
    initialFen,
    finalFen: session.fen,
    steps: Object.freeze(steps),
  });
}
