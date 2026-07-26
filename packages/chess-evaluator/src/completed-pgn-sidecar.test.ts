import { replayCompletedPgn } from "@drawbackengine/chess-core";
import {
  createEvaluatorTurnConstraintRequest,
} from "@drawbackengine/drawback-engine";
import { describe, expect, it } from "vitest";
import {
  buildCompletedPgnEvaluatorSidecar,
  completedPgnEvaluatorSidecarDigest,
  loadAuthenticatedCompletedPgnEvaluatorSidecar,
  serializeCompletedPgnEvaluatorSidecar,
  validateCompletedPgnEvaluatorSidecar,
  type CompletedPgnEvaluatorPolicy,
} from "./completed-pgn-sidecar.js";
import {
  createConstraintCacheRecord,
  type ConstraintCacheRecord,
} from "./constraint-cache.js";

const PGN = `[Event "Completed"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1
`;

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function mutableClone<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Fixture is missing value at index ${String(index)}.`);
  }
  return value;
}

const EXECUTABLE_SHA256 = "ab".repeat(32);
const OPTIONS_DIGEST = "cd".repeat(32);
const POLICY: CompletedPgnEvaluatorPolicy = {
  provider: "uci-best-move",
  id: "stockfish-bestmove-v1",
  version: 1,
  engine: {
    uciName: "Stockfish 18",
    engine: "stockfish",
    version: "18",
    executableSha256: EXECUTABLE_SHA256,
    optionsDigest: OPTIONS_DIGEST,
    publicFingerprint:
      `stockfish:18:${EXECUTABLE_SHA256}:${OPTIONS_DIGEST}`,
  },
  searchLimit: { kind: "nodes", value: 10_000 },
};

async function records(pgn = PGN): Promise<readonly ConstraintCacheRecord[]> {
  return Promise.all(
    replayCompletedPgn(pgn).steps.map((step) => {
      const request = createEvaluatorTurnConstraintRequest(
        {
          fen: step.fenBefore,
          turn: step.color,
          ply: step.ply - 1,
          history: step.historyBefore,
        },
        step.ordinaryLegalMoves,
      );
      return createConstraintCacheRecord(
        {
          policy: { id: POLICY.id, version: POLICY.version },
          fingerprint: {
            engine: POLICY.engine.engine,
            version: POLICY.engine.version,
            optionsDigest: POLICY.engine.optionsDigest,
          },
          fen: request.fen,
          rootMoves: request.ordinaryRootMoves,
          limit: { nodes: 10_000 },
        },
        request.ordinaryRootMoves[0] ?? null,
      );
    }),
  );
}

async function built() {
  return buildCompletedPgnEvaluatorSidecar({
    pgn: PGN,
    policy: POLICY,
    records: await records(),
  });
}

async function bytesSha256(bytes: Uint8Array): Promise<string> {
  const copied: Uint8Array<ArrayBuffer> = new Uint8Array(bytes);
  return [
    ...new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", copied),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("completed-PGN evaluator sidecar", () => {
  it("builds a deterministic frozen sidecar and derives exact constraints", async () => {
    const first = await built();
    const second = await built();
    const validated = await validateCompletedPgnEvaluatorSidecar(
      first.sidecar,
      PGN,
    );

    expect(first).toEqual(second);
    expect(first.sha256).toBe(
      await completedPgnEvaluatorSidecarDigest(first.sidecar),
    );
    const serialized = serializeCompletedPgnEvaluatorSidecar(first.sidecar);
    const serializedDigest = [
      ...new Uint8Array(
        await globalThis.crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(serialized),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(serializedDigest).toBe(first.sha256);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.sidecar.plies).toHaveLength(4);
    expect(validated.constraints).toHaveLength(4);
    expect(validated.constraints[0]).toMatchObject({
      provider: "uci-best-move",
      policyId: "stockfish-bestmove-v1",
      bestMoveUci: first.sidecar.plies[0]?.record.bestMove,
      engineFingerprint: POLICY.engine.publicFingerprint,
    });
    expect(Object.isFrozen(first.sidecar)).toBe(true);
    expect(Object.isFrozen(first.sidecar.policy.engine)).toBe(true);
    expect(Object.isFrozen(first.sidecar.plies)).toBe(true);
    expect(Object.isFrozen(first.sidecar.plies[0]?.record)).toBe(true);
    expect(Object.isFrozen(validated.constraints)).toBe(true);
  });

  it("rejects partial, reordered, unknown-field, and wrong-PGN sidecars", async () => {
    const { sidecar } = await built();
    const partial = mutableClone(sidecar);
    partial.plies.pop();
    await expect(
      validateCompletedPgnEvaluatorSidecar(partial, PGN),
    ).rejects.toThrow("exactly one entry");

    const reordered = mutableClone(sidecar);
    [reordered.plies[0], reordered.plies[1]] = [
      requiredAt(reordered.plies, 1),
      requiredAt(reordered.plies, 0),
    ];
    await expect(
      validateCompletedPgnEvaluatorSidecar(reordered, PGN),
    ).rejects.toThrow("complete and ordered");

    const unknown = {
      ...mutableClone(sidecar),
      trueDrawback: "vegan",
    };
    await expect(
      validateCompletedPgnEvaluatorSidecar(unknown, PGN),
    ).rejects.toThrow("unknown or missing");

    const hiddenRecordField = mutableClone(sidecar) as typeof sidecar & {
      plies: Array<{
        record: ConstraintCacheRecord & { trueDrawback?: string };
      }>;
    };
    requiredAt(hiddenRecordField.plies, 0).record.trueDrawback = "vegan";
    await expect(
      validateCompletedPgnEvaluatorSidecar(hiddenRecordField, PGN),
    ).rejects.toThrow("unknown or missing");

    await expect(
      validateCompletedPgnEvaluatorSidecar(
        sidecar,
        PGN.replace('[Event "Completed"]', '[Event "Changed"]'),
      ),
    ).rejects.toThrow("does not match");
  });

  it("rejects cache, request, policy, and engine-provenance tampering", async () => {
    const { sidecar } = await built();
    const digestTamper = mutableClone(sidecar);
    requiredAt(digestTamper.plies, 0).record.requestDigest = "0".repeat(64);
    await expect(
      validateCompletedPgnEvaluatorSidecar(digestTamper, PGN),
    ).rejects.toThrow();

    const requestTamper = mutableClone(sidecar);
    requiredAt(requestTamper.plies, 0).record.request.fen =
      requiredAt(requestTamper.plies, 1).record.request.fen;
    await expect(
      validateCompletedPgnEvaluatorSidecar(requestTamper, PGN),
    ).rejects.toThrow();

    const policyTamper = mutableClone(sidecar);
    policyTamper.policy.id = "other-policy";
    await expect(
      validateCompletedPgnEvaluatorSidecar(policyTamper, PGN),
    ).rejects.toThrow("does not match evaluator request");

    const fingerprintTamper = mutableClone(sidecar);
    fingerprintTamper.policy.engine.publicFingerprint = "wrong";
    await expect(
      validateCompletedPgnEvaluatorSidecar(fingerprintTamper, PGN),
    ).rejects.toThrow("does not match provenance");
  });

  it("rejects a valid cache record bound to another replay ply", async () => {
    const { sidecar } = await built();
    const substituted = mutableClone(sidecar);
    requiredAt(substituted.plies, 0).record = mutableClone(
      requiredAt(substituted.plies, 1).record,
    );

    await expect(
      validateCompletedPgnEvaluatorSidecar(substituted, PGN),
    ).rejects.toThrow("does not match replay request");
  });

  it("authenticates exact canonical bytes before parsing", async () => {
    const generated = await built();
    const serialized = serializeCompletedPgnEvaluatorSidecar(
      generated.sidecar,
    );
    const bytes = new TextEncoder().encode(serialized);

    await expect(
      loadAuthenticatedCompletedPgnEvaluatorSidecar(
        bytes,
        PGN,
        generated.sha256,
      ),
    ).resolves.toMatchObject({
      artifactSha256: generated.sha256,
      constraints: { length: 4 },
    });
    await expect(
      loadAuthenticatedCompletedPgnEvaluatorSidecar(
        bytes,
        PGN,
        "0".repeat(64),
      ),
    ).rejects.toThrow("SHA-256 mismatch");

    const noncanonical = new TextEncoder().encode(`${serialized}\n`);
    await expect(
      loadAuthenticatedCompletedPgnEvaluatorSidecar(
        noncanonical,
        PGN,
        await bytesSha256(noncanonical),
      ),
    ).rejects.toThrow("not canonical");

    const duplicateKeyText = serialized.replace(
      '"format":',
      `"format":"${generated.sidecar.format}","format":`,
    );
    const duplicateKey = new TextEncoder().encode(duplicateKeyText);
    await expect(
      loadAuthenticatedCompletedPgnEvaluatorSidecar(
        duplicateKey,
        PGN,
        await bytesSha256(duplicateKey),
      ),
    ).rejects.toThrow("not canonical");
  });

  it("rejects byte-order marks in sidecar and PGN inputs", async () => {
    const generated = await built();
    const serialized = serializeCompletedPgnEvaluatorSidecar(
      generated.sidecar,
    );
    const payload = new TextEncoder().encode(serialized);
    const bom = new Uint8Array(payload.length + 3);
    bom.set([0xef, 0xbb, 0xbf]);
    bom.set(payload, 3);

    await expect(
      loadAuthenticatedCompletedPgnEvaluatorSidecar(
        bom,
        PGN,
        await bytesSha256(bom),
      ),
    ).rejects.toThrow("must not contain a BOM");
    await expect(
      buildCompletedPgnEvaluatorSidecar({
        pgn: `\uFEFF${PGN}`,
        policy: POLICY,
        records: await records(),
      }),
    ).rejects.toThrow("must not begin with a byte-order mark");
  });
});
