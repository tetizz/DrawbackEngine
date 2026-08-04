import type {
  NodeFairyStockfishLeafEvaluatorConfig,
  NodeStockfishLeafEvaluatorConfig,
  NodeUciLeafEvaluatorConfig,
  OwnedNodeUciLeafEvaluator,
  createOwnedNodeUciLeafEvaluator,
} from "@drawbackengine/chess-evaluator";
import {
  NodeUciLeafEvaluatorCloseError,
} from "@drawbackengine/chess-evaluator";
import {
  inspectPublicGameTrace,
  publicAuthorityLegalMoves,
  publicGameTraceView,
} from "@drawbackengine/chess-core";
import type { IterativePlayerPrivateSearchResult } from "@drawbackengine/drawback-search";
import {
  PlayerPrivatePlayGame,
  type PlayerPrivateEvaluatorPolicy,
  type PlayerPrivatePlaySearch,
  type PlayerPrivatePlaySearchRequest,
} from "@drawbackengine/simulation-arena";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  runPlayerPrivatePlayCli,
  runWithOwnedPlayEvaluator,
  type PlayerPrivatePlayTerminal,
} from "./play-cli.js";

describe("local player-private play CLI", () => {
  it("prints help without loading or starting an evaluator", async () => {
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
    const loadEvaluatorPolicy = vi.fn(loadTestPolicy);
    const createEvaluator = vi.fn(createTestEvaluator);

    const result = await runPlayerPrivatePlayCli({
      arguments: ["--help"],
      output,
      loadEvaluatorPolicy,
      createEvaluator,
    });

    expect(result).toEqual({ kind: "help", plies: 0 });
    expect(written.join("")).toContain("DrawbackEngine local play");
    expect(loadEvaluatorPolicy).not.toHaveBeenCalled();
    expect(createEvaluator).not.toHaveBeenCalled();
  });

  it("plays through one persistent private session and owned evaluator", async () => {
    const terminal = scriptedTerminal(["e2-e4", "resign"]);
    const evaluator = testEvaluator();
    const createEvaluatorImplementation: typeof createOwnedNodeUciLeafEvaluator = (
      _config: NodeUciLeafEvaluatorConfig,
      control = {},
    ) => {
      expect(control.signal?.aborted).toBe(false);
      return Promise.resolve(evaluator);
    };
    const createEvaluator = vi.fn(createEvaluatorImplementation);
    const createdGames: PlayerPrivatePlayGame[] = [];
    const createGame: typeof PlayerPrivatePlayGame.create = (options) => {
      const game = PlayerPrivatePlayGame.create(
        { ...options, engineDrawbackId: "checkers" },
        { search: preferredSearch("e7", "e5") },
      );
      createdGames.push(game);
      return game;
    };

    const result = await runPlayerPrivatePlayCli({
      arguments: [
        "--evaluator-config",
        "C:\\trusted\\engine.json",
        "--human-color",
        "white",
        "--human-drawback",
        "vegan",
        "--max-depth",
        "1",
        "--max-nodes",
        "1000",
      ],
      terminal,
      loadEvaluatorPolicy: loadTestPolicy,
      createEvaluator,
      createGame,
    });

    expect(result).toEqual({ kind: "resigned", plies: 2 });
    expect(createdGames).toHaveLength(1);
    expect(createEvaluator).toHaveBeenCalledOnce();
    expect(evaluator.closeSpy).toHaveBeenCalledOnce();
    expect(terminal.closeSpy).toHaveBeenCalledOnce();
    const output = terminal.lines.join("\n");
    expect(output).toContain("Your drawback: Vegan");
    expect(output).toContain("You played e2-e4.");
    expect(output).toContain("Engine played e7-e5");
    expect(output).toContain(
      "Engine setting: target depth 1, node cap 1000; evaluator test-evaluator.",
    );
    expect(output).not.toMatch(/completed depth|outer nodes|depth 1\/1/iu);
    expect(output).toContain("Post-game reveal:");
    expect(output.indexOf("Checkers")).toBeGreaterThan(
      output.indexOf("Post-game reveal:"),
    );
  });

  it("passes startup cancellation to the evaluator and closes the terminal", async () => {
    const controller = new AbortController();
    const terminal = scriptedTerminal([]);
    const cancellation = new Error("startup cancelled");
    const createEvaluator: typeof createOwnedNodeUciLeafEvaluator = (
      _config,
      control = {},
    ) => {
      expect(control.signal).toBe(controller.signal);
      controller.abort(cancellation);
      return Promise.reject(cancellation);
    };

    await expect(runPlayerPrivatePlayCli({
      arguments: [
        "--evaluator-config",
        "C:\\trusted\\engine.json",
      ],
      signal: controller.signal,
      terminal,
      loadEvaluatorPolicy: loadTestPolicy,
      createEvaluator,
    })).rejects.toBe(cancellation);
    expect(terminal.closeSpy).toHaveBeenCalledOnce();
  });

  it("rejects orthodox Stockfish before starting capturable-king play", async () => {
    const terminal = scriptedTerminal([]);
    const createEvaluator = vi.fn(createTestEvaluator);

    await expect(runPlayerPrivatePlayCli({
      arguments: [
        "--evaluator-config",
        "C:\\trusted\\orthodox-engine.json",
      ],
      terminal,
      loadEvaluatorPolicy: () => Promise.resolve({
        ...testPolicy(),
        config: orthodoxTestConfig(),
      }),
      createEvaluator,
    })).rejects.toThrow(
      "requires an authenticated Fairy-Stockfish evaluator",
    );
    expect(createEvaluator).not.toHaveBeenCalled();
    expect(terminal.closeSpy).toHaveBeenCalledOnce();
  });

  it("cancels an active engine search without applying a move", async () => {
    const controller = new AbortController();
    const cancellation = new Error("search cancelled");
    const terminal = scriptedTerminal([]);
    const evaluator = testEvaluator();
    let game: PlayerPrivatePlayGame | undefined;
    const started = vi.fn();
    const search: PlayerPrivatePlaySearch = async ({ limits }) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        limits.signal?.addEventListener(
          "abort",
          () => {
            const reason: unknown = limits.signal?.reason;
            reject(
              reason instanceof Error ? reason : new Error("search cancelled"),
            );
          },
          { once: true },
        );
      });
      throw new Error("unreachable");
    };
    const createGame: typeof PlayerPrivatePlayGame.create = (options) => {
      game = PlayerPrivatePlayGame.create(
        { ...options, engineDrawbackId: "checkers" },
        { search },
      );
      return game;
    };
    const pending = runPlayerPrivatePlayCli({
      arguments: [
        "--evaluator-config",
        "C:\\trusted\\engine.json",
        "--human-color",
        "black",
        "--human-drawback",
        "vegan",
      ],
      signal: controller.signal,
      terminal,
      loadEvaluatorPolicy: loadTestPolicy,
      createEvaluator: () => Promise.resolve(evaluator),
      createGame,
    });
    await vi.waitFor(() => {
      expect(started).toHaveBeenCalledOnce();
    });
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(game?.observation()).toMatchObject({ ply: 0, turn: "white" });
    expect(evaluator.closeSpy).toHaveBeenCalledOnce();
    expect(terminal.closeSpy).toHaveBeenCalledOnce();
  });

  it("retries incomplete shutdown on the exact evaluator and preserves failure", async () => {
    const operationFailure = new Error("operation failed");
    const close = vi.fn()
      .mockRejectedValueOnce(new NodeUciLeafEvaluatorCloseError(
        "not closed",
        false,
        false,
      ))
      .mockResolvedValueOnce(undefined);
    const evaluator: OwnedNodeUciLeafEvaluator = {
      id: "test-evaluator",
      evaluate: () => Promise.resolve(0),
      close,
    };

    await expect(runWithOwnedPlayEvaluator(
      evaluator,
      async () => Promise.reject(operationFailure),
    )).rejects.toSatisfy((error: unknown) =>
      containsErrorIdentity(error, operationFailure)
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("orients a black player's board from h-file to a-file", async () => {
    const terminal = scriptedTerminal(["quit"]);
    const evaluator = testEvaluator();

    await runPlayerPrivatePlayCli({
      arguments: [
        "--evaluator-config",
        "C:\\trusted\\engine.json",
        "--human-color",
        "black",
        "--human-drawback",
        "vegan",
      ],
      terminal,
      loadEvaluatorPolicy: loadTestPolicy,
      createEvaluator: () => Promise.resolve(evaluator),
      createGame: (options) => PlayerPrivatePlayGame.create(
        { ...options, engineDrawbackId: "checkers" },
        { search: preferredSearch("e2", "e4") },
      ),
    });

    expect(terminal.lines).toContain("   h g f e d c b a");
    expect(evaluator.closeSpy).toHaveBeenCalledOnce();
  });
});

interface ScriptedTerminal extends PlayerPrivatePlayTerminal {
  readonly lines: string[];
  readonly closeSpy: ReturnType<typeof vi.fn>;
}

function scriptedTerminal(answers: readonly string[]): ScriptedTerminal {
  const pending = [...answers];
  const lines: string[] = [];
  const closeSpy = vi.fn();
  return {
    lines,
    writeLine(line = ""): void {
      lines.push(line);
    },
    question(_prompt: string, signal: AbortSignal): Promise<string> {
      if (signal.aborted) {
        const reason: unknown = signal.reason;
        return Promise.reject(
          reason instanceof Error ? reason : new Error("terminal cancelled"),
        );
      }
      const answer = pending.shift();
      if (answer === undefined) {
        return Promise.reject(
          new Error("The scripted terminal has no remaining answers."),
        );
      }
      return Promise.resolve(answer);
    },
    close(): void {
      closeSpy();
    },
    closeSpy,
  };
}

function loadTestPolicy(): Promise<PlayerPrivateEvaluatorPolicy> {
  return Promise.resolve(testPolicy());
}

function testPolicy(): Extract<
  PlayerPrivateEvaluatorPolicy,
  { readonly kind: "node-uci-leaf" }
> {
  return {
    kind: "node-uci-leaf",
    version: 1,
    evaluatorId: "test-evaluator",
    config: testConfig(),
  };
}

function createTestEvaluator(): Promise<OwnedNodeUciLeafEvaluator> {
  return Promise.resolve(testEvaluator());
}

function testEvaluator(): OwnedNodeUciLeafEvaluator & {
  readonly closeSpy: ReturnType<typeof vi.fn>;
} {
  const closeSpy = vi.fn();
  return {
    id: "test-evaluator",
    evaluate: () => Promise.resolve(0),
    close(): Promise<void> {
      closeSpy();
      return Promise.resolve();
    },
    closeSpy,
  };
}

function testConfig(): NodeFairyStockfishLeafEvaluatorConfig {
  return {
    kind: "fairy-stockfish",
    process: {
      executablePath: "C:\\trusted\\stockfish.exe",
      executableSha256: "a".repeat(64),
      cwd: "C:\\trusted",
      shutdownTimeoutMs: 1_000,
      runtimeContextSha256: "b".repeat(64),
    },
    client: { timeoutMs: 1_000 },
    engineIdentity: {
      uciName: "Test Engine",
      engine: "stockfish",
      version: "test-v1",
      advertisedOptionsSha256: "c".repeat(64),
    },
    depth: 1,
    hashMb: 16,
    unsupportedPosition: "error",
    fairyVariant: {
      bytes: new Uint8Array(),
      sha256: "d".repeat(64),
    },
  };
}

function orthodoxTestConfig(): NodeStockfishLeafEvaluatorConfig {
  const config = testConfig();
  return {
    kind: "stockfish",
    process: config.process,
    client: config.client,
    engineIdentity: config.engineIdentity,
    depth: config.depth,
    hashMb: config.hashMb,
    unsupportedPosition: config.unsupportedPosition,
  };
}

function preferredSearch(from: string, to: string): PlayerPrivatePlaySearch {
  return (request) => Promise.resolve(chooseLegalMove(request, from, to));
}

function chooseLegalMove(
  request: PlayerPrivatePlaySearchRequest,
  preferredFrom: string,
  preferredTo: string,
): IterativePlayerPrivateSearchResult {
  const position = publicGameTraceView(request.context.trace);
  const authority = publicAuthorityLegalMoves(
    inspectPublicGameTrace(request.context.trace).current,
  );
  const legal = request.context.own.legalMoves(position, authority);
  const move = legal.find(
    (candidate) =>
      candidate.from === preferredFrom && candidate.to === preferredTo,
  ) ?? legal[0];
  if (move === undefined) {
    throw new Error("Expected at least one exact engine move.");
  }
  return Object.freeze({
    move,
    score: 25,
    principalVariation: Object.freeze([move]),
    nodes: 1,
    leaves: 0,
    truncated: false,
    rootColor: position.turn,
    evaluatorId: request.evaluator.id,
    knowledgeMode: "player-private",
    aggregation: request.context.aggregation,
    opponentHypothesisCount: request.context.opponent.length,
    requestedDepth: request.limits.maxDepth,
    completedDepth: request.limits.maxDepth,
    stopReason: "target-depth",
    rootMoves: Object.freeze([
      Object.freeze({
        move,
        score: 25,
        principalVariation: Object.freeze([move]),
      }),
    ]),
    leafCache: Object.freeze({
      hits: 0,
      misses: 0,
      evictions: 0,
      entries: 0,
      maxEntries: 1,
      historyMode: "full",
    }),
  });
}

function containsErrorIdentity(value: unknown, expected: Error): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    if (current === expected) {
      return true;
    }
    seen.add(current);
    if (current instanceof AggregateError) {
      pending.push(...current.errors as readonly unknown[]);
    }
    if (current instanceof Error && current.cause !== undefined) {
      pending.push(current.cause);
    }
  }
  return false;
}
