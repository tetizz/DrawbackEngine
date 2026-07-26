import { describe, expect, it } from "vitest";
import {
  PRIVATE_SIMULATION_TRACE_FORMAT,
  PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
  encodePrivateSimulationTraceRecord,
  parsePrivateSimulationTraceLine,
  parsePrivateSimulationTraceRecord,
  simulationGameId,
  type PrivateSimulationTraceRecord,
} from "./index.js";

const INITIAL_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 =
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

function fixture(): PrivateSimulationTraceRecord {
  return {
    format: PRIVATE_SIMULATION_TRACE_FORMAT,
    schemaVersion: PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
    authorityId: "standard-chess/v1",
    gameIndex: 3,
    gameId: simulationGameId(19, 3),
    seed: 19,
    plyLimit: 1,
    initialFen: INITIAL_FEN,
    finalFen: AFTER_E4,
    result: { kind: "active" },
    stoppedAtPlyLimit: true,
    evaluatorCoverage: "none",
    drawbacks: { white: "unrestricted", black: "unrestricted" },
    agents: {
      white: { id: "random-legal", style: "random", strength: 100 },
      black: { id: "random-legal", style: "random", strength: 100 },
    },
    plies: [
      {
        ply: 0,
        color: "white",
        fenBefore: INITIAL_FEN,
        fenAfter: AFTER_E4,
        move: { uci: "e2e4", san: "e4" },
        ordinaryLegalMoves: [
          "a2a3",
          "a2a4",
          "b1a3",
          "b1c3",
          "b2b3",
          "b2b4",
          "c2c3",
          "c2c4",
          "d2d3",
          "d2d4",
          "e2e3",
          "e2e4",
          "f2f3",
          "f2f4",
          "g1f3",
          "g1h3",
          "g2g3",
          "g2g4",
          "h2h3",
          "h2h4",
        ],
        drawbackLegalMoves: [
          "a2a3",
          "a2a4",
          "b1a3",
          "b1c3",
          "b2b3",
          "b2b4",
          "c2c3",
          "c2c4",
          "d2d3",
          "d2d4",
          "e2e3",
          "e2e4",
          "f2f3",
          "f2f4",
          "g1f3",
          "g1h3",
          "g2g3",
          "g2g4",
          "h2h3",
          "h2h4",
        ],
        ruleTriggered: false,
        forced: false,
        publicEvaluatorConstraint: null,
        activeSecret: {
          drawbackId: "unrestricted",
          hiddenParameters: {},
          drawbackInternalState: {},
        },
      },
    ],
  };
}

describe("private simulation trace v1", () => {
  it("round-trips deterministic canonical NDJSON", () => {
    const record = fixture();
    const encoded = encodePrivateSimulationTraceRecord(record);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(parsePrivateSimulationTraceLine(encoded.trimEnd())).toEqual(record);
    expect(encodePrivateSimulationTraceRecord(record)).toBe(encoded);
  });

  it("rejects unknown keys, missing keys, and unsupported versions", () => {
    expect(() =>
      parsePrivateSimulationTraceRecord({ ...fixture(), extra: true }),
    ).toThrow("extra is not supported");
    const withoutAuthority: Record<string, unknown> = { ...fixture() };
    delete withoutAuthority["authorityId"];
    expect(() => parsePrivateSimulationTraceRecord(withoutAuthority)).toThrow(
      "authorityId is required",
    );
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...fixture(),
        schemaVersion: 2,
      }),
    ).toThrow("schemaVersion is unsupported");
  });

  it("rejects malformed masks, labels, FEN chains, and non-JSON secrets", () => {
    const record = fixture();
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...record,
        plies: [
          {
            ...record.plies[0],
            drawbackLegalMoves: ["d2d4"],
          },
        ],
      }),
    ).toThrow("move.uci must be drawback-legal");
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...record,
        drawbacks: { white: "vegan", black: "unrestricted" },
      }),
    ).toThrow("does not match the post-game reveal");
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...record,
        finalFen: INITIAL_FEN,
      }),
    ).toThrow("finalFen must equal");
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...record,
        plies: [
          {
            ...record.plies[0],
            activeSecret: {
              ...record.plies[0]?.activeSecret,
              hiddenParameters: undefined,
            },
          },
        ],
      }),
    ).toThrow("JSON-safe");
  });

  it("replays complete chess semantics and evaluator provenance", () => {
    const record = fixture();
    const first = record.plies[0];
    if (first === undefined) {
      throw new Error("Expected one fixture ply.");
    }
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...record,
        plies: [
          {
            ...first,
            ordinaryLegalMoves: first.ordinaryLegalMoves.slice(1),
            drawbackLegalMoves: first.drawbackLegalMoves.slice(1),
          },
        ],
      }),
    ).toThrow("complete authority-legal set");
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...record,
        plies: [{ ...first, move: { ...first.move, san: "Nonsense" } }],
      }),
    ).toThrow("move does not match authority replay");
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...record,
        evaluatorCoverage: "uniform",
        plies: [
          {
            ...first,
            publicEvaluatorConstraint: {
              provider: "uci-best-move",
              policyId: "stockfish-bestmove-v1",
              positionKey: "stale",
              requestDigest: "ab".repeat(32),
              bestMoveUci: "e2e4",
              engineFingerprint: "test-engine",
            },
          },
        ],
      }),
    ).toThrow("does not match the public position");
  });

  it("rejects inconsistent scheduling and agent provenance", () => {
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...fixture(),
        stoppedAtPlyLimit: false,
      }),
    ).toThrow("exactly when the result is active");
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...fixture(),
        plyLimit: 2,
      }),
    ).toThrow("exactly plyLimit plies");
    const record = fixture();
    expect(() =>
      parsePrivateSimulationTraceRecord({
        ...record,
        agents: {
          ...record.agents,
          white: { ...record.agents.white, strength: -1 },
        },
      }),
    ).toThrow("non-negative safe integer");
  });

  it("preserves hostile JSON keys and canonicalizes secret object order", () => {
    const hostile = JSON.parse(
      "{\"__proto__\":{\"polluted\":true},\"z\":1}",
    ) as unknown;
    const withSecret = (
      hiddenParameters: unknown,
    ): unknown => {
      const record = fixture();
      return {
        ...record,
        plies: [
          {
            ...record.plies[0],
            activeSecret: {
              ...record.plies[0]?.activeSecret,
              hiddenParameters,
            },
          },
        ],
      };
    };
    const parsed = parsePrivateSimulationTraceRecord(withSecret(hostile));
    const parameters = parsed.plies[0]?.activeSecret.hiddenParameters;
    expect(
      typeof parameters === "object"
      && parameters !== null
      && !Array.isArray(parameters)
      && Object.hasOwn(parameters, "__proto__"),
    ).toBe(true);
    expect(
      ({} as Readonly<Record<string, unknown>>)["polluted"],
    ).toBeUndefined();
    expect(
      encodePrivateSimulationTraceRecord(
        withSecret({ "é": 3, "Ω": 2, a: 1 }),
      ),
    ).toBe(
      encodePrivateSimulationTraceRecord(
        withSecret({ a: 1, "Ω": 2, "é": 3 }),
      ),
    );
    expect(() =>
      parsePrivateSimulationTraceRecord(withSecret(new Date())),
    ).toThrow("plain JSON objects");
  });

  it("normalizes into a mutation-independent value", () => {
    const source = fixture();
    const parsed = parsePrivateSimulationTraceRecord(source);
    const sourceMoves = source.plies[0]?.ordinaryLegalMoves as string[];
    sourceMoves.push("a1a1");
    expect(parsed.plies[0]?.ordinaryLegalMoves).toHaveLength(20);
    expect(parsed.plies[0]?.ordinaryLegalMoves).not.toContain("a1a1");
  });

  it("uses standard UCI promotion suffixes", () => {
    const record = fixture();
    const promotion = {
      ...record,
      initialFen: "8/P7/8/8/8/8/7k/K7 w - - 0 1",
      finalFen: "Q7/8/8/8/8/8/7k/K7 b - - 0 1",
      plies: [
        {
          ...record.plies[0],
          fenBefore: "8/P7/8/8/8/8/7k/K7 w - - 0 1",
          fenAfter: "Q7/8/8/8/8/8/7k/K7 b - - 0 1",
          move: { uci: "a7a8q", san: "a8=Q" },
          ordinaryLegalMoves: [
            "a1a2",
            "a1b1",
            "a1b2",
            "a7a8b",
            "a7a8n",
            "a7a8q",
            "a7a8r",
          ],
          drawbackLegalMoves: [
            "a1a2",
            "a1b1",
            "a1b2",
            "a7a8b",
            "a7a8n",
            "a7a8q",
            "a7a8r",
          ],
        },
      ],
    };
    expect(parsePrivateSimulationTraceRecord(promotion).plies[0]?.move.uci).toBe(
      "a7a8q",
    );
  });
});
