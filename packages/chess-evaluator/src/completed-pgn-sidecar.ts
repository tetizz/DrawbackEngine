import { replayCompletedPgn } from "@drawbackengine/chess-core";
import {
  createEvaluatorTurnConstraintRequest,
  type ExternalTurnConstraint,
} from "@drawbackengine/drawback-engine";
import {
  canonicalRequestMaterial,
  canonicalizeConstraintRequest,
  validateConstraintCacheRecord,
  type CanonicalSearchLimit,
  type ConstraintCacheRecord,
  type ConstraintEngineFingerprint,
} from "./constraint-cache.js";
import type { UciSearchLimit } from "./types.js";

export const COMPLETED_PGN_EVALUATOR_SIDECAR_FORMAT =
  "drawbacktrainer-completed-pgn-evaluator-sidecar";
export const COMPLETED_PGN_EVALUATOR_SIDECAR_VERSION = 1;
export const MAX_COMPLETED_PGN_EVALUATOR_SIDECAR_BYTES = 8 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/u;
const PROVIDER = "uci-best-move";

export interface CompletedPgnEvaluatorPolicy {
  readonly provider: "uci-best-move";
  readonly id: string;
  readonly version: number;
  readonly engine: {
    readonly uciName: string;
    readonly engine: string;
    readonly version: string;
    readonly executableSha256: string;
    readonly optionsDigest: string;
    readonly publicFingerprint: string;
  };
  readonly searchLimit: CanonicalSearchLimit;
}

export interface CompletedPgnEvaluatorPly {
  readonly ply: number;
  readonly record: ConstraintCacheRecord;
}

export interface CompletedPgnEvaluatorSidecar {
  readonly format: typeof COMPLETED_PGN_EVALUATOR_SIDECAR_FORMAT;
  readonly version: typeof COMPLETED_PGN_EVALUATOR_SIDECAR_VERSION;
  readonly completedOnly: true;
  readonly pgnSha256: string;
  readonly normalizedMainlineSha256: string;
  readonly policy: CompletedPgnEvaluatorPolicy;
  readonly plies: readonly CompletedPgnEvaluatorPly[];
}

export interface ValidatedCompletedPgnEvaluatorSidecar {
  readonly sidecar: CompletedPgnEvaluatorSidecar;
  readonly constraints: readonly ExternalTurnConstraint[];
}

export interface AuthenticatedCompletedPgnEvaluatorSidecar
extends ValidatedCompletedPgnEvaluatorSidecar {
  /** Exact canonical artifact bytes verified before JSON parsing. */
  readonly artifactSha256: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new TypeError(`${label} must be non-empty trimmed text.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function serializeCompletedPgnEvaluatorSidecar(
  sidecar: CompletedPgnEvaluatorSidecar,
): string {
  return canonicalJson(sidecar);
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> = typeof value === "string"
    ? new TextEncoder().encode(value)
    : new Uint8Array(value);
  const output = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes,
  );
  return [...new Uint8Array(output)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validatePgnString(pgn: unknown): string {
  if (typeof pgn !== "string") {
    throw new TypeError("completed PGN must be a string.");
  }
  if (pgn.startsWith("\uFEFF")) {
    throw new TypeError("completed PGN must not begin with a byte-order mark.");
  }
  return pgn;
}

function parseLimit(value: unknown): CanonicalSearchLimit {
  const item = record(value, "sidecar policy searchLimit");
  exact(item, ["kind", "value"], "sidecar policy searchLimit");
  if (
    item["kind"] !== "depth" &&
    item["kind"] !== "move-time-ms" &&
    item["kind"] !== "nodes"
  ) {
    throw new TypeError("sidecar policy searchLimit kind is invalid.");
  }
  return Object.freeze({
    kind: item["kind"],
    value: positiveInteger(item["value"], "sidecar policy searchLimit value"),
  });
}

function toUciSearchLimit(limit: CanonicalSearchLimit): UciSearchLimit {
  switch (limit.kind) {
    case "depth":
      return { depth: limit.value };
    case "move-time-ms":
      return { moveTimeMs: limit.value };
    case "nodes":
      return { nodes: limit.value };
  }
}

function parsePolicy(value: unknown): CompletedPgnEvaluatorPolicy {
  const item = record(value, "sidecar policy");
  exact(
    item,
    ["provider", "id", "version", "engine", "searchLimit"],
    "sidecar policy",
  );
  if (item["provider"] !== PROVIDER) {
    throw new TypeError("sidecar policy provider is unsupported.");
  }
  const engine = record(item["engine"], "sidecar policy engine");
  exact(
    engine,
    [
      "uciName",
      "engine",
      "version",
      "executableSha256",
      "optionsDigest",
      "publicFingerprint",
    ],
    "sidecar policy engine",
  );
  const executableSha256 = digest(
    engine["executableSha256"],
    "sidecar executableSha256",
  );
  const optionsDigest = digest(
    engine["optionsDigest"],
    "sidecar optionsDigest",
  );
  const engineName = text(engine["engine"], "sidecar engine name");
  const engineVersion = text(engine["version"], "sidecar engine version");
  if (engineName.includes(":") || engineVersion.includes(":")) {
    throw new TypeError(
      "sidecar engine name and version cannot contain the fingerprint delimiter.",
    );
  }
  const publicFingerprint = text(
    engine["publicFingerprint"],
    "sidecar public fingerprint",
  );
  if (
    publicFingerprint !==
      [engineName, engineVersion, executableSha256, optionsDigest].join(":")
  ) {
    throw new TypeError("sidecar public fingerprint does not match provenance.");
  }
  return Object.freeze({
    provider: PROVIDER,
    id: text(item["id"], "sidecar policy id"),
    version: positiveInteger(item["version"], "sidecar policy version"),
    engine: Object.freeze({
      uciName: text(engine["uciName"], "sidecar UCI name"),
      engine: engineName,
      version: engineVersion,
      executableSha256,
      optionsDigest,
      publicFingerprint,
    }),
    searchLimit: parseLimit(item["searchLimit"]),
  });
}

function strictCacheRecord(
  value: unknown,
  label: string,
): ConstraintCacheRecord {
  const item = record(value, label);
  exact(
    item,
    [
      "schemaVersion",
      "key",
      "requestDigest",
      "recordDigest",
      "request",
      "bestMove",
    ],
    label,
  );
  const request = record(item["request"], `${label} request`);
  exact(
    request,
    [
      "schemaVersion",
      "policy",
      "fingerprint",
      "fen",
      "rootMoves",
      "limit",
    ],
    `${label} request`,
  );
  exact(
    record(request["policy"], `${label} request policy`),
    ["id", "version"],
    `${label} request policy`,
  );
  exact(
    record(request["fingerprint"], `${label} request fingerprint`),
    ["engine", "version", "optionsDigest"],
    `${label} request fingerprint`,
  );
  exact(
    record(request["limit"], `${label} request limit`),
    ["kind", "value"],
    `${label} request limit`,
  );
  return item as unknown as ConstraintCacheRecord;
}

function fingerprint(
  policy: CompletedPgnEvaluatorPolicy,
): ConstraintEngineFingerprint {
  return {
    engine: policy.engine.engine,
    version: policy.engine.version,
    optionsDigest: policy.engine.optionsDigest,
  };
}

export async function completedPgnEvaluatorSidecarDigest(
  sidecar: CompletedPgnEvaluatorSidecar,
): Promise<string> {
  return sha256(serializeCompletedPgnEvaluatorSidecar(sidecar));
}

export async function validateCompletedPgnEvaluatorSidecar(
  value: unknown,
  pgn: string,
): Promise<ValidatedCompletedPgnEvaluatorSidecar> {
  const validatedPgn = validatePgnString(pgn);
  const item = record(value, "completed-PGN evaluator sidecar");
  exact(
    item,
    [
      "format",
      "version",
      "completedOnly",
      "pgnSha256",
      "normalizedMainlineSha256",
      "policy",
      "plies",
    ],
    "completed-PGN evaluator sidecar",
  );
  if (
    item["format"] !== COMPLETED_PGN_EVALUATOR_SIDECAR_FORMAT ||
    typeOfNumber(item["version"]) !== COMPLETED_PGN_EVALUATOR_SIDECAR_VERSION ||
    item["completedOnly"] !== true
  ) {
    throw new TypeError("completed-PGN evaluator sidecar identity is invalid.");
  }
  const replay = replayCompletedPgn(validatedPgn);
  const expectedPgnSha256 = await sha256(validatedPgn);
  const expectedMainlineSha256 = await sha256(
    canonicalJson(replay.normalizedMainline),
  );
  if (
    digest(item["pgnSha256"], "sidecar pgnSha256") !== expectedPgnSha256 ||
    digest(
      item["normalizedMainlineSha256"],
      "sidecar normalizedMainlineSha256",
    ) !== expectedMainlineSha256
  ) {
    throw new TypeError("sidecar does not match the completed PGN.");
  }
  const policy = parsePolicy(item["policy"]);
  const rawPlies = item["plies"];
  if (!Array.isArray(rawPlies) || rawPlies.length !== replay.steps.length) {
    throw new TypeError("sidecar must contain exactly one entry per replay ply.");
  }
  const plies: CompletedPgnEvaluatorPly[] = [];
  const constraints: ExternalTurnConstraint[] = [];
  for (const [index, step] of replay.steps.entries()) {
    const rawPly = record(rawPlies[index], `sidecar ply ${String(index + 1)}`);
    exact(rawPly, ["ply", "record"], `sidecar ply ${String(index + 1)}`);
    if (rawPly["ply"] !== step.ply) {
      throw new TypeError("sidecar ply entries must be complete and ordered.");
    }
    const validatedRecord = await validateConstraintCacheRecord(
      strictCacheRecord(
        rawPly["record"],
        `sidecar ply ${String(index + 1)} cache record`,
      ),
    );
    const request = createEvaluatorTurnConstraintRequest(
      {
        fen: step.fenBefore,
        turn: step.color,
        ply: step.ply - 1,
        history: step.historyBefore,
      },
      step.ordinaryLegalMoves,
    );
    if (request.policyId !== policy.id) {
      throw new TypeError("sidecar policy does not match evaluator request.");
    }
    const expectedRequest = canonicalizeConstraintRequest({
      policy: { id: policy.id, version: policy.version },
      fingerprint: fingerprint(policy),
      fen: request.fen,
      rootMoves: request.ordinaryRootMoves,
      limit: toUciSearchLimit(policy.searchLimit),
    });
    if (
      canonicalRequestMaterial(validatedRecord.request) !==
        canonicalRequestMaterial(expectedRequest) ||
      validatedRecord.bestMove === null
    ) {
      throw new TypeError("sidecar cache record does not match replay request.");
    }
    plies.push(Object.freeze({ ply: step.ply, record: validatedRecord }));
    constraints.push(Object.freeze({
      provider: PROVIDER,
      policyId: policy.id,
      positionKey: request.positionKey,
      requestDigest: validatedRecord.requestDigest,
      bestMoveUci: validatedRecord.bestMove,
      engineFingerprint: policy.engine.publicFingerprint,
    }));
  }
  const sidecar: CompletedPgnEvaluatorSidecar = Object.freeze({
    format: COMPLETED_PGN_EVALUATOR_SIDECAR_FORMAT,
    version: COMPLETED_PGN_EVALUATOR_SIDECAR_VERSION,
    completedOnly: true,
    pgnSha256: expectedPgnSha256,
    normalizedMainlineSha256: expectedMainlineSha256,
    policy,
    plies: Object.freeze(plies),
  });
  return Object.freeze({
    sidecar,
    constraints: Object.freeze(constraints),
  });
}

/**
 * Authenticates exact sidecar bytes against a digest obtained from a trusted
 * manifest or another independent channel before parsing any JSON.
 */
export async function loadAuthenticatedCompletedPgnEvaluatorSidecar(
  bytes: Uint8Array,
  pgn: string,
  expectedSha256: string,
): Promise<AuthenticatedCompletedPgnEvaluatorSidecar> {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("sidecar bytes must be a Uint8Array.");
  }
  if (bytes.byteLength > MAX_COMPLETED_PGN_EVALUATOR_SIDECAR_BYTES) {
    throw new RangeError("completed-PGN evaluator sidecar exceeds the byte limit.");
  }
  const expected = digest(expectedSha256, "expected sidecar SHA-256");
  if (await sha256(bytes) !== expected) {
    throw new TypeError("completed-PGN evaluator sidecar SHA-256 mismatch.");
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new TypeError("completed-PGN evaluator sidecar must not contain a BOM.");
  }
  let serialized: string;
  try {
    serialized = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch (error) {
    throw new TypeError(
      "completed-PGN evaluator sidecar must be valid UTF-8.",
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new TypeError("completed-PGN evaluator sidecar must be valid JSON.", {
      cause: error,
    });
  }
  const validated = await validateCompletedPgnEvaluatorSidecar(value, pgn);
  if (
    serializeCompletedPgnEvaluatorSidecar(validated.sidecar) !== serialized
  ) {
    throw new TypeError(
      "completed-PGN evaluator sidecar bytes are not canonical.",
    );
  }
  return Object.freeze({
    ...validated,
    artifactSha256: expected,
  });
}

function typeOfNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

export async function buildCompletedPgnEvaluatorSidecar(input: {
  readonly pgn: string;
  readonly policy: CompletedPgnEvaluatorPolicy;
  readonly records: readonly ConstraintCacheRecord[];
}): Promise<{
  readonly sidecar: CompletedPgnEvaluatorSidecar;
  readonly sha256: string;
}> {
  const pgn = validatePgnString(input.pgn);
  const replay = replayCompletedPgn(pgn);
  const candidate = {
    format: COMPLETED_PGN_EVALUATOR_SIDECAR_FORMAT,
    version: COMPLETED_PGN_EVALUATOR_SIDECAR_VERSION,
    completedOnly: true,
    pgnSha256: await sha256(pgn),
    normalizedMainlineSha256: await sha256(
      canonicalJson(replay.normalizedMainline),
    ),
    policy: input.policy,
    plies: input.records.map((recordValue, index) => ({
      ply: index + 1,
      record: recordValue,
    })),
  };
  const validated = await validateCompletedPgnEvaluatorSidecar(
    candidate,
    pgn,
  );
  return Object.freeze({
    sidecar: validated.sidecar,
    sha256: await completedPgnEvaluatorSidecarDigest(validated.sidecar),
  });
}
