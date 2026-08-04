import { describe, expect, it } from "vitest";
import type {
  ExternalTurnConstraintRequest,
} from "@drawbackengine/drawback-engine";
import { UciClient } from "./client.js";
import { AuthenticatedNodeUciEngineCloseError } from "./authenticated-node-uci-engine.js";
import type { UciTransport } from "./types.js";
import { UciProcessTerminationError } from "./types.js";
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

  it("shares one in-flight owned-runtime cleanup", async () => {
    const client = await initializedClient();
    let cleanupCalls = 0;
    let release: (() => void) | undefined;
    const provider = new UciTurnConstraintProvider({
      client,
      policy: POLICY,
      dispose: () => {
        cleanupCalls += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    const first = provider.dispose();
    const second = provider.dispose();
    expect(second).toBe(first);
    expect(cleanupCalls).toBe(0);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(cleanupCalls).toBe(1);
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("retries incomplete owned-runtime cleanup and stays logically disposed", async () => {
    const client = await initializedClient();
    let cleanupCalls = 0;
    const incomplete = new AuthenticatedNodeUciEngineCloseError(
      "Process termination is not yet proven.",
      true,
      false,
    );
    const provider = new UciTurnConstraintProvider({
      client,
      policy: POLICY,
      dispose: () => {
        cleanupCalls += 1;
        return cleanupCalls === 1
          ? Promise.reject(incomplete)
          : Promise.resolve();
      },
    });

    await expect(provider.dispose()).rejects.toBe(incomplete);
    await expect(provider.resolve(request())).rejects.toThrow("disposed");
    await expect(provider.dispose()).resolves.toBeUndefined();
    await expect(provider.dispose()).resolves.toBeUndefined();
    expect(cleanupCalls).toBe(2);
  });

  it("caches a terminal cleanup failure after every resource is gone", async () => {
    const client = await initializedClient();
    let cleanupCalls = 0;
    const terminal = new AuthenticatedNodeUciEngineCloseError(
      "Cleanup completed with an abnormal shutdown.",
      true,
      true,
    );
    const provider = new UciTurnConstraintProvider({
      client,
      policy: POLICY,
      dispose: () => {
        cleanupCalls += 1;
        return Promise.reject(terminal);
      },
    });

    const first = provider.dispose();
    await expect(first).rejects.toBe(terminal);
    const second = provider.dispose();
    expect(second).toBe(first);
    await expect(second).rejects.toBe(terminal);
    expect(cleanupCalls).toBe(1);
  });

  it("caches a terminal default-client shutdown failure", async () => {
    const lines = [
      "id name Stockfish Test 17.1",
      "uciok",
      "readyok",
    ];
    let closeCalls = 0;
    const terminal = new UciProcessTerminationError(
      "The process required forced termination.",
      true,
    );
    const transport: UciTransport = {
      send: () => Promise.resolve(),
      lines: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve(
            lines.length === 0
              ? { done: true, value: undefined }
              : { done: false, value: lines.shift() ?? "" },
          ),
        }),
      }),
      close: () => {
        closeCalls += 1;
        return Promise.reject(terminal);
      },
    };
    const client = new UciClient(transport);
    await client.initialize();
    const provider = new UciTurnConstraintProvider({ client, policy: POLICY });

    const first = provider.dispose();
    await expect(first).rejects.toBe(terminal);
    const second = provider.dispose();
    expect(second).toBe(first);
    await expect(second).rejects.toBe(terminal);
    expect(closeCalls).toBe(1);
  });
});

async function initializedClient(): Promise<UciClient> {
  const transport = new MockUciTransport([
    {
      command: "uci",
      responses: ["id name Stockfish Test 17.1", "uciok"],
    },
    { command: "isready", responses: ["readyok"] },
  ]);
  const client = new UciClient(transport);
  await client.initialize();
  return client;
}
