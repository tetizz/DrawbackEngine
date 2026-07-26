import { describe, expect, it } from "vitest";
import type {
  ExternalTurnConstraintRequest,
} from "@drawbackengine/drawback-engine";
import { UciClient } from "./client.js";
import { MockUciTransport } from "./mock-transport.js";
import {
  UciTurnConstraintProvider,
  type UciTurnConstraintPolicy,
} from "./turn-constraint-provider.js";

const FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const ROOTS = ["d2d4", "e2e4"] as const;
const POLICY: UciTurnConstraintPolicy = {
  identity: { id: "stockfish-bestmove-v1", version: 1 },
  fingerprint: {
    engine: "stockfish-test",
    version: "17.1",
    optionsDigest: "ab".repeat(32),
  },
  expectedUciName: "Stockfish Test 17.1",
  publicEngineFingerprint: "stockfish-test-17.1-ab",
  limit: { nodes: 1_000 },
};

function request(
  overrides: Partial<ExternalTurnConstraintRequest> = {},
): ExternalTurnConstraintRequest {
  return {
    provider: "uci-best-move",
    policyId: POLICY.identity.id,
    fen: FEN,
    ordinaryRootMoves: ROOTS,
    positionKey: JSON.stringify([FEN, ROOTS]),
    ...overrides,
  };
}

describe("UciTurnConstraintProvider", () => {
  it("resets, evaluates the complete canonical root mask, and caches the fact", async () => {
    const actualTransport = new MockUciTransport([
      {
        command: "uci",
        responses: [
          "id name Stockfish Test 17.1",
          "option name Clear Hash type button",
          "uciok",
        ],
      },
      { command: "isready", responses: ["readyok"] },
      { command: "ucinewgame" },
      { command: "setoption name Clear Hash" },
      { command: "isready", responses: ["readyok"] },
      { command: `position fen ${FEN}` },
      {
        command: "go nodes 1000 searchmoves d2d4 e2e4",
        responses: ["bestmove e2e4"],
      },
      { command: "quit", closeAfter: true },
    ]);
    const actualClient = new UciClient(actualTransport);
    await actualClient.initialize();
    const actual = new UciTurnConstraintProvider({
      client: actualClient,
      policy: POLICY,
    });

    const first = await actual.resolve(request());
    const second = await actual.resolve(request({
      ordinaryRootMoves: ["e2e4", "d2d4"],
      positionKey: JSON.stringify([FEN, ["d2d4", "e2e4"]]),
    }));
    expect(first.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).toEqual({
      provider: "uci-best-move",
      policyId: "stockfish-bestmove-v1",
      positionKey: JSON.stringify([FEN, ROOTS]),
      requestDigest: first.requestDigest,
      bestMoveUci: "e2e4",
      engineFingerprint: POLICY.publicEngineFingerprint,
    });
    expect(second.bestMoveUci).toBe(first.bestMoveUci);
    expect(actualTransport.commands.filter((command) =>
      command.startsWith("go ")
    )).toHaveLength(1);
    await actual.dispose();
    await actual.dispose();
    expect(actualTransport.complete).toBe(true);
  });

  it("fails closed for stale, empty, wrong-policy, and disposed requests", async () => {
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: [
          "id name Stockfish Test 17.1",
          "option name Clear Hash type button",
          "uciok",
        ],
      },
      { command: "isready", responses: ["readyok"] },
      { command: "quit", closeAfter: true },
    ]);
    const client = new UciClient(transport);
    await client.initialize();
    expect(
      () =>
        new UciTurnConstraintProvider({
          client,
          policy: { ...POLICY, expectedUciName: "Different Engine" },
        }),
    ).toThrow("does not match");
    const provider = new UciTurnConstraintProvider({
      client,
      policy: POLICY,
    });

    await expect(provider.resolve(request({
      policyId: "other-policy",
    }))).rejects.toThrow("not configured");
    await expect(provider.resolve(request({
      positionKey: "stale",
    }))).rejects.toThrow("position key");
    await expect(provider.resolve(request({
      ordinaryRootMoves: [],
      positionKey: JSON.stringify([FEN, []]),
    }))).rejects.toThrow("at least one");
    await provider.dispose();
    await expect(provider.resolve(request())).rejects.toThrow("disposed");
  });
});
