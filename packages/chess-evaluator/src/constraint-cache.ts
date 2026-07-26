import type { UciSearchLimit } from "./types.js";

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/u;
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._:/+-]{0,127})$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const PIECES = /^[prnbqkPRNBQK1-8]+$/u;

export class ConstraintCacheValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConstraintCacheValidationError";
  }
}

export class ConstraintCacheConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConstraintCacheConflictError";
  }
}

export class ConstraintCacheCorruptionError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConstraintCacheCorruptionError";
  }
}

export interface ConstraintPolicyIdentity {
  readonly id: string;
  readonly version: number;
}

export interface ConstraintEngineFingerprint {
  readonly engine: string;
  readonly version: string;
  /** Canonical caller-owned digest of all evaluation-affecting options. */
  readonly optionsDigest: string;
}

export interface ConstraintRequest {
  readonly policy: ConstraintPolicyIdentity;
  readonly fingerprint: ConstraintEngineFingerprint;
  readonly fen: string;
  readonly rootMoves: readonly string[];
  readonly limit: UciSearchLimit;
}

export type CanonicalSearchLimit =
  | { readonly kind: "depth"; readonly value: number }
  | { readonly kind: "move-time-ms"; readonly value: number }
  | { readonly kind: "nodes"; readonly value: number };

export interface CanonicalConstraintRequest {
  readonly schemaVersion: 1;
  readonly policy: ConstraintPolicyIdentity;
  readonly fingerprint: ConstraintEngineFingerprint;
  readonly fen: string;
  readonly rootMoves: readonly string[];
  readonly limit: CanonicalSearchLimit;
}

export interface ConstraintCacheRecord {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly requestDigest: string;
  readonly recordDigest: string;
  readonly request: CanonicalConstraintRequest;
  readonly bestMove: string | null;
}

function validation(message: string): never {
  throw new ConstraintCacheValidationError(message);
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) {
    validation(`${label} must be a non-empty canonical identifier.`);
  }
  return normalized;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    validation(`${label} must be a positive safe integer.`);
  }
  return value;
}

function normalizeBoard(board: string): string {
  const ranks = board.split("/");
  if (ranks.length !== 8) {
    validation("FEN board must contain exactly eight ranks.");
  }
  let whiteKings = 0;
  let blackKings = 0;
  for (const rank of ranks) {
    if (!PIECES.test(rank) || /[1-8]{2}/u.test(rank)) {
      validation("FEN board contains an invalid rank.");
    }
    let squares = 0;
    for (const symbol of rank) {
      if (symbol >= "1" && symbol <= "8") {
        squares += Number(symbol);
      } else {
        squares += 1;
        whiteKings += symbol === "K" ? 1 : 0;
        blackKings += symbol === "k" ? 1 : 0;
      }
    }
    if (squares !== 8) {
      validation("Each FEN rank must describe exactly eight squares.");
    }
  }
  if (whiteKings !== 1 || blackKings !== 1) {
    validation("FEN must contain exactly one king of each color.");
  }
  return board;
}

function normalizeCastling(value: string): string {
  if (value === "-") {
    return value;
  }
  if (!/^[KQkq]+$/u.test(value) || new Set(value).size !== value.length) {
    validation("FEN castling rights are invalid.");
  }
  return Array.from("KQkq")
    .filter((right) => value.includes(right))
    .join("");
}

export function normalizeFen(fen: string): string {
  const fields = fen.trim().split(/\s+/u);
  if (fields.length !== 6) {
    validation("FEN must contain exactly six fields.");
  }
  const [board, turn, castling, enPassant, halfmove, fullmove] = fields;
  if (
    board === undefined ||
    turn === undefined ||
    castling === undefined ||
    enPassant === undefined ||
    halfmove === undefined ||
    fullmove === undefined
  ) {
    validation("FEN fields are incomplete.");
  }
  normalizeBoard(board);
  if (turn !== "w" && turn !== "b") {
    validation("FEN active color must be w or b.");
  }
  const normalizedCastling = normalizeCastling(castling);
  if (enPassant !== "-" && !/^[a-h][36]$/u.test(enPassant)) {
    validation("FEN en-passant target is invalid.");
  }
  if (!/^[0-9]+$/u.test(halfmove)) {
    validation("FEN halfmove clock must be a non-negative integer.");
  }
  if (!/^[0-9]+$/u.test(fullmove) || Number(fullmove) < 1) {
    validation("FEN fullmove number must be a positive integer.");
  }
  const halfmoveNumber = Number(halfmove);
  const fullmoveNumber = Number(fullmove);
  if (
    !Number.isSafeInteger(halfmoveNumber) ||
    !Number.isSafeInteger(fullmoveNumber)
  ) {
    validation("FEN move counters must be safe integers.");
  }
  return [
    board,
    turn,
    normalizedCastling,
    enPassant,
    String(halfmoveNumber),
    String(fullmoveNumber),
  ].join(" ");
}

export function normalizeRootMoves(
  rootMoves: readonly string[],
): readonly string[] {
  const normalized = rootMoves.map((move) => move.trim().toLowerCase());
  for (const move of normalized) {
    if (!UCI_MOVE.test(move)) {
      validation(`Invalid UCI root move: ${move}.`);
    }
  }
  return Object.freeze([...new Set(normalized)].sort());
}

function canonicalLimit(limit: UciSearchLimit): CanonicalSearchLimit {
  if ("depth" in limit) {
    return Object.freeze({
      kind: "depth",
      value: requirePositiveSafeInteger(limit.depth, "Search depth"),
    });
  }
  if ("moveTimeMs" in limit) {
    return Object.freeze({
      kind: "move-time-ms",
      value: requirePositiveSafeInteger(limit.moveTimeMs, "Search move time"),
    });
  }
  return Object.freeze({
    kind: "nodes",
    value: requirePositiveSafeInteger(limit.nodes, "Search nodes"),
  });
}

export function canonicalizeConstraintRequest(
  request: ConstraintRequest,
): CanonicalConstraintRequest {
  const policy = Object.freeze({
    id: requireIdentifier(request.policy.id, "Policy id"),
    version: requirePositiveSafeInteger(
      request.policy.version,
      "Policy version",
    ),
  });
  const fingerprint = Object.freeze({
    engine: requireIdentifier(request.fingerprint.engine, "Engine name"),
    version: requireIdentifier(request.fingerprint.version, "Engine version"),
    optionsDigest: request.fingerprint.optionsDigest.toLowerCase(),
  });
  if (!SHA256.test(fingerprint.optionsDigest)) {
    validation("Engine options digest must be a lowercase SHA-256 digest.");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    policy,
    fingerprint,
    fen: normalizeFen(request.fen),
    rootMoves: normalizeRootMoves(request.rootMoves),
    limit: canonicalLimit(request.limit),
  });
}

export function canonicalRequestMaterial(
  request: CanonicalConstraintRequest,
): string {
  return JSON.stringify({
    schemaVersion: request.schemaVersion,
    policy: {
      id: request.policy.id,
      version: request.policy.version,
    },
    fingerprint: {
      engine: request.fingerprint.engine,
      version: request.fingerprint.version,
      optionsDigest: request.fingerprint.optionsDigest,
    },
    fen: request.fen,
    rootMoves: request.rootMoves,
    limit: {
      kind: request.limit.kind,
      value: request.limit.value,
    },
  });
}

async function sha256Hex(material: string): Promise<string> {
  // Web Crypto keeps this primitive browser-safe. Runtimes without
  // `crypto.subtle` must install an explicit adapter instead of changing keys.
  const subtle = globalThis.crypto.subtle;
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function constraintRequestDigest(
  request: CanonicalConstraintRequest,
): Promise<string> {
  return sha256Hex(canonicalRequestMaterial(request));
}

export async function constraintCacheKey(
  request: ConstraintRequest,
): Promise<string> {
  const canonical = canonicalizeConstraintRequest(request);
  return `constraint-v1:${await constraintRequestDigest(canonical)}`;
}

function validateBestMove(
  bestMove: string | null,
  rootMoves: readonly string[],
): string | null {
  if (bestMove === null) {
    return null;
  }
  const normalized = bestMove.trim().toLowerCase();
  if (!UCI_MOVE.test(normalized)) {
    validation(`Invalid UCI best move: ${bestMove}.`);
  }
  if (rootMoves.length > 0 && !rootMoves.includes(normalized)) {
    validation("Best move is outside the canonical root move set.");
  }
  return normalized;
}

function immutableRequest(
  request: CanonicalConstraintRequest,
): CanonicalConstraintRequest {
  return Object.freeze({
    schemaVersion: 1,
    policy: Object.freeze({ ...request.policy }),
    fingerprint: Object.freeze({ ...request.fingerprint }),
    fen: request.fen,
    rootMoves: Object.freeze([...request.rootMoves]),
    limit: Object.freeze({ ...request.limit }),
  });
}

function immutableRecord(record: ConstraintCacheRecord): ConstraintCacheRecord {
  return Object.freeze({
    schemaVersion: 1,
    key: record.key,
    requestDigest: record.requestDigest,
    recordDigest: record.recordDigest,
    request: immutableRequest(record.request),
    bestMove: record.bestMove,
  });
}

async function recordDigest(
  requestDigest: string,
  bestMove: string | null,
): Promise<string> {
  return sha256Hex(JSON.stringify({ requestDigest, bestMove }));
}

export async function createConstraintCacheRecord(
  input: ConstraintRequest,
  bestMove: string | null,
): Promise<ConstraintCacheRecord> {
  const request = canonicalizeConstraintRequest(input);
  const normalizedBestMove = validateBestMove(bestMove, request.rootMoves);
  const requestDigest = await constraintRequestDigest(request);
  return immutableRecord({
    schemaVersion: 1,
    key: `constraint-v1:${requestDigest}`,
    requestDigest,
    recordDigest: await recordDigest(requestDigest, normalizedBestMove),
    request,
    bestMove: normalizedBestMove,
  });
}

export async function validateConstraintCacheRecord(
  candidate: ConstraintCacheRecord,
): Promise<ConstraintCacheRecord> {
  if (
    (candidate as { readonly schemaVersion: unknown }).schemaVersion !== 1
  ) {
    throw new ConstraintCacheCorruptionError(
      "Constraint cache record schema version is unsupported.",
    );
  }
  let request: CanonicalConstraintRequest;
  let bestMove: string | null;
  try {
    request = canonicalizeConstraintRequest({
      policy: candidate.request.policy,
      fingerprint: candidate.request.fingerprint,
      fen: candidate.request.fen,
      rootMoves: candidate.request.rootMoves,
      limit:
        candidate.request.limit.kind === "depth"
          ? { depth: candidate.request.limit.value }
          : candidate.request.limit.kind === "move-time-ms"
            ? { moveTimeMs: candidate.request.limit.value }
            : { nodes: candidate.request.limit.value },
    });
    bestMove = validateBestMove(candidate.bestMove, request.rootMoves);
  } catch (error) {
    throw new ConstraintCacheCorruptionError(
      "Constraint cache record contains invalid request or best-move data.",
      { cause: error },
    );
  }
  const requestDigest = await constraintRequestDigest(request);
  const key = `constraint-v1:${requestDigest}`;
  const expectedRecordDigest = await recordDigest(requestDigest, bestMove);
  const candidateMaterial = canonicalRequestMaterial(candidate.request);
  const canonicalMaterial = canonicalRequestMaterial(request);
  if (
    candidateMaterial !== canonicalMaterial ||
    candidate.key !== key ||
    candidate.requestDigest !== requestDigest ||
    candidate.recordDigest !== expectedRecordDigest
  ) {
    throw new ConstraintCacheCorruptionError(
      "Constraint cache record digest or key does not match its contents.",
    );
  }
  return immutableRecord({
    schemaVersion: 1,
    key,
    requestDigest,
    recordDigest: expectedRecordDigest,
    request,
    bestMove,
  });
}

export class ConstraintCache {
  readonly #records = new Map<string, ConstraintCacheRecord>();
  readonly #inFlight = new Map<string, Promise<ConstraintCacheRecord>>();

  public get size(): number {
    return this.#records.size;
  }

  public async get(
    request: ConstraintRequest,
  ): Promise<ConstraintCacheRecord | null> {
    const key = await constraintCacheKey(request);
    const record = this.#records.get(key);
    return record === undefined
      ? null
      : validateConstraintCacheRecord(record);
  }

  public async prime(
    candidate: ConstraintCacheRecord,
  ): Promise<ConstraintCacheRecord> {
    const record = await validateConstraintCacheRecord(candidate);
    const existing = this.#records.get(record.key);
    if (
      existing !== undefined &&
      existing.recordDigest !== record.recordDigest
    ) {
      throw new ConstraintCacheConflictError(
        "Constraint cache already contains a conflicting result for this request.",
      );
    }
    this.#records.set(record.key, record);
    return record;
  }

  public async set(
    request: ConstraintRequest,
    bestMove: string | null,
  ): Promise<ConstraintCacheRecord> {
    return this.prime(await createConstraintCacheRecord(request, bestMove));
  }

  public async getOrCompute(
    request: ConstraintRequest,
    compute: (
      canonicalRequest: CanonicalConstraintRequest,
    ) => PromiseLike<string | null> | string | null,
  ): Promise<ConstraintCacheRecord> {
    const canonical = canonicalizeConstraintRequest(request);
    const requestDigest = await constraintRequestDigest(canonical);
    const key = `constraint-v1:${requestDigest}`;
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      return validateConstraintCacheRecord(existing);
    }
    const pending = this.#inFlight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const created = Promise.resolve()
      .then(async () => {
        const bestMove = await compute(immutableRequest(canonical));
        return await this.set(canonicalToRequest(canonical), bestMove);
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, created);
    return created;
  }
}

function canonicalToRequest(
  request: CanonicalConstraintRequest,
): ConstraintRequest {
  return {
    policy: request.policy,
    fingerprint: request.fingerprint,
    fen: request.fen,
    rootMoves: request.rootMoves,
    limit:
      request.limit.kind === "depth"
        ? { depth: request.limit.value }
        : request.limit.kind === "move-time-ms"
          ? { moveTimeMs: request.limit.value }
          : { nodes: request.limit.value },
  };
}
