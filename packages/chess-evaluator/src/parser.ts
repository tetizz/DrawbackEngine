import type { UciScore, UciSearchInfo } from "./types.js";
import { UciProtocolError } from "./types.js";

function integer(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function score(tokens: readonly string[]): UciScore | null {
  const scoreIndex = tokens.indexOf("score");
  if (scoreIndex < 0) {
    return null;
  }
  const type = tokens[scoreIndex + 1];
  const value = integer(tokens[scoreIndex + 2]);
  if ((type !== "cp" && type !== "mate") || value === null) {
    throw new UciProtocolError("Malformed UCI info score.");
  }
  const remaining = tokens.slice(scoreIndex + 3);
  const bound = remaining.includes("lowerbound")
    ? "lower"
    : remaining.includes("upperbound")
      ? "upper"
      : "exact";
  return type === "cp"
    ? { kind: "centipawns", value, bound }
    : { kind: "mate", moves: value, bound };
}

function valueAfter(tokens: readonly string[], key: string): number | null {
  const index = tokens.indexOf(key);
  return index < 0 ? null : integer(tokens[index + 1]);
}

export function parseInfo(line: string): UciSearchInfo | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "info") {
    return null;
  }
  const pvIndex = tokens.indexOf("pv");
  return {
    depth: valueAfter(tokens, "depth"),
    selectiveDepth: valueAfter(tokens, "seldepth"),
    nodes: valueAfter(tokens, "nodes"),
    score: score(tokens),
    principalVariation: pvIndex < 0 ? [] : tokens.slice(pvIndex + 1),
  };
}

export function parseBestMove(line: string): {
  readonly bestMove: string | null;
  readonly ponderMove: string | null;
} | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "bestmove") {
    return null;
  }
  const rawMove = tokens[1];
  if (rawMove === undefined) {
    throw new UciProtocolError("Malformed UCI bestmove response.");
  }
  const bestMove = rawMove === "(none)" || rawMove === "0000" ? null : rawMove;
  const ponderIndex = tokens.indexOf("ponder");
  const ponderMove =
    ponderIndex < 0 ? null : (tokens[ponderIndex + 1] ?? null);
  return { bestMove, ponderMove };
}
