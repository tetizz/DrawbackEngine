import { describe, expect, it } from "vitest";
import {
  ConstraintCache,
  ConstraintCacheConflictError,
  ConstraintCacheCorruptionError,
  ConstraintCacheValidationError,
  canonicalRequestMaterial,
  canonicalizeConstraintRequest,
  constraintCacheKey,
  createConstraintCacheRecord,
  normalizeFen,
  normalizeRootMoves,
  validateConstraintCacheRecord,
  type ConstraintCacheRecord,
  type ConstraintRequest,
} from "./constraint-cache.js";

const OPTIONS_DIGEST = "ab".repeat(32);
const FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function request(
  overrides: Partial<ConstraintRequest> = {},
): ConstraintRequest {
  return {
    policy: { id: "stockfish-bestmove", version: 1 },
    fingerprint: {
      engine: "stockfish",
      version: "17.1",
      optionsDigest: OPTIONS_DIGEST,
    },
    fen: FEN,
    rootMoves: ["e2e4", "d2d4"],
    limit: { nodes: 10_000 },
    ...overrides,
  };
}

describe("constraint cache canonicalization", () => {
  it("normalizes exactly six FEN fields and canonical castling/counters", () => {
    expect(normalizeFen(
      "  rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR   w qKQk - 000 01 ",
    )).toBe(FEN);
    for (const invalid of [
      "8/8/8/8/8/8/8/8 w - - 0",
      "8/8/8/8/8/8/8/K6k x - - 0 1",
      "8/8/8/8/8/8/8/K6k w - a4 0 1",
      "8/8/8/8/8/8/8/8 w - - 0 1",
      "9/8/8/8/8/8/8/K6k w - - 0 1",
      "44/8/8/8/8/8/8/K6k w - - 0 1",
    ]) {
      expect(() => normalizeFen(invalid)).toThrow(
        ConstraintCacheValidationError,
      );
    }
  });

  it("sorts, deduplicates, lowercases, validates, and freezes root moves", () => {
    const moves = normalizeRootMoves([" E2E4 ", "d2d4", "e2e4", "a7a8Q"]);
    expect(moves).toEqual(["a7a8q", "d2d4", "e2e4"]);
    expect(Object.isFrozen(moves)).toBe(true);
    expect(() => normalizeRootMoves(["e2e9"])).toThrow(
      ConstraintCacheValidationError,
    );
  });

  it("produces identical SHA-256 keys for equivalent requests", async () => {
    const first = request();
    const second = request({
      fen: ` ${FEN.replace("KQkq", "qkQK")} `,
      rootMoves: ["d2d4", "e2e4", "d2d4"],
    });
    await expect(constraintCacheKey(first)).resolves.toBe(
      await constraintCacheKey(second),
    );
    expect(await constraintCacheKey(first)).toMatch(
      /^constraint-v1:[0-9a-f]{64}$/u,
    );
    expect(await constraintCacheKey(first)).toBe(
      "constraint-v1:aca9948290fe7ff478fa1035c6a06f17f79cc14ad3d4ecb5c8c5d0a5e64e9949",
    );
    expect(canonicalRequestMaterial(
      canonicalizeConstraintRequest(first),
    )).toBe(canonicalRequestMaterial(
      canonicalizeConstraintRequest(second),
    ));
  });

  it("includes policy, fingerprint, request, and limit in key material", async () => {
    const baseline = await constraintCacheKey(request());
    const variants = [
      request({ policy: { id: "stockfish-bestmove", version: 2 } }),
      request({
        fingerprint: {
          engine: "stockfish",
          version: "17.2",
          optionsDigest: OPTIONS_DIGEST,
        },
      }),
      request({ rootMoves: ["e2e4"] }),
      request({ limit: { depth: 10 } }),
    ];
    for (const variant of variants) {
      await expect(constraintCacheKey(variant)).resolves.not.toBe(baseline);
    }
  });

  it("rejects invalid policy, fingerprint, request limits, and best moves", async () => {
    await expect(constraintCacheKey(request({
      policy: { id: "", version: 1 },
    }))).rejects.toThrow(ConstraintCacheValidationError);
    await expect(constraintCacheKey(request({
      fingerprint: {
        engine: "stockfish",
        version: "17.1",
        optionsDigest: "not-a-digest",
      },
    }))).rejects.toThrow(ConstraintCacheValidationError);
    await expect(constraintCacheKey(request({
      limit: { nodes: 0 },
    }))).rejects.toThrow(ConstraintCacheValidationError);
    await expect(
      createConstraintCacheRecord(request(), "g1f3"),
    ).rejects.toThrow("outside the canonical root move set");
    await expect(
      createConstraintCacheRecord(request(), "invalid"),
    ).rejects.toThrow("Invalid UCI best move");
  });
});

describe("constraint cache records", () => {
  it("creates deeply immutable validated records", async () => {
    const record = await createConstraintCacheRecord(request(), "E2E4");
    expect(record.bestMove).toBe("e2e4");
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.request)).toBe(true);
    expect(Object.isFrozen(record.request.policy)).toBe(true);
    expect(Object.isFrozen(record.request.fingerprint)).toBe(true);
    expect(Object.isFrozen(record.request.rootMoves)).toBe(true);
    expect(Object.isFrozen(record.request.limit)).toBe(true);
    await expect(validateConstraintCacheRecord(record)).resolves.toEqual(record);
  });

  it("detects corrupted keys, request digests, records, and best moves", async () => {
    const record = await createConstraintCacheRecord(request(), "e2e4");
    const corruptions: ConstraintCacheRecord[] = [
      { ...record, key: `constraint-v1:${"0".repeat(64)}` },
      { ...record, requestDigest: "0".repeat(64) },
      { ...record, recordDigest: "0".repeat(64) },
      { ...record, bestMove: "g1f3" },
      {
        ...record,
        request: {
          ...record.request,
          fingerprint: { ...record.request.fingerprint, version: "" },
        },
      },
      {
        ...record,
        request: {
          ...record.request,
          rootMoves: ["e2e4", "d2d4"],
        },
      },
    ];
    for (const corrupted of corruptions) {
      await expect(
        validateConstraintCacheRecord(corrupted),
      ).rejects.toThrow(ConstraintCacheCorruptionError);
    }
  });

  it("rejects conflicting results and accepts identical records idempotently", async () => {
    const cache = new ConstraintCache();
    const first = await cache.set(request(), "e2e4");
    await expect(cache.prime(first)).resolves.toEqual(first);
    await expect(cache.set(request(), "d2d4")).rejects.toThrow(
      ConstraintCacheConflictError,
    );
    expect(cache.size).toBe(1);
  });
});

describe("constraint cache coalescing", () => {
  it("coalesces equivalent in-flight requests and caches the immutable result", async () => {
    const cache = new ConstraintCache();
    let resolve!: (move: string) => void;
    const deferred = new Promise<string>((done) => {
      resolve = done;
    });
    let calls = 0;
    const compute = () => {
      calls += 1;
      return deferred;
    };
    const first = cache.getOrCompute(request(), compute);
    const second = cache.getOrCompute(
      request({ rootMoves: ["d2d4", "e2e4", "d2d4"] }),
      compute,
    );
    await Promise.resolve();
    resolve("e2e4");
    const [left, right] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(left).toBe(right);
    expect(cache.size).toBe(1);
    await expect(cache.get(request())).resolves.toStrictEqual(left);
  });

  it("clears failed in-flight work so a later request can retry", async () => {
    const cache = new ConstraintCache();
    let calls = 0;
    await expect(cache.getOrCompute(request(), () => {
      calls += 1;
      throw new Error("engine failed");
    })).rejects.toThrow("engine failed");
    await expect(cache.getOrCompute(request(), () => {
      calls += 1;
      return "e2e4";
    })).resolves.toMatchObject({ bestMove: "e2e4" });
    expect(calls).toBe(2);
  });

  it("validates computed best moves before publishing or caching them", async () => {
    const cache = new ConstraintCache();
    await expect(
      cache.getOrCompute(request(), () => "g1f3"),
    ).rejects.toThrow("outside the canonical root move set");
    expect(cache.size).toBe(0);
  });
});
