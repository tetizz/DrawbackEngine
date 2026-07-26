import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DrawbackGameSession,
} from "@drawbackengine/chess-core";
import {
  createStockfishLeafEvaluator,
  initializeFairyStockfishLeafEvaluator,
  NodeProcessUciTransport,
  UciClient,
} from "@drawbackengine/chess-evaluator";
import {
  searchIterativeOmniscientDrawbackMove,
} from "@drawbackengine/drawback-search";
import {
  checkersRule,
  veganRule,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";

interface CliOptions {
  readonly stockfish: string;
  readonly stockfishSha256: string;
  readonly engineKind: "stockfish" | "fairy-stockfish";
  readonly depth: number;
  readonly leafDepth: number;
  readonly maxNodes: number;
  readonly variantPath?: string;
  readonly fen?: string;
}

function valueAfter(
  arguments_: readonly string[],
  name: string,
): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${value} must be a positive integer.`);
  }
  return parsed;
}

function parseOptions(arguments_: readonly string[]): CliOptions {
  const configured =
    valueAfter(arguments_, "--stockfish")
    ?? process.env["STOCKFISH_PATH"];
  if (configured === undefined) {
    throw new Error(
      "Provide an exact Stockfish binary with --stockfish or STOCKFISH_PATH.",
    );
  }
  const stockfish = resolve(configured);
  if (!existsSync(stockfish)) {
    throw new Error(`Stockfish binary does not exist: ${stockfish}`);
  }
  const expectedSha256 = valueAfter(arguments_, "--stockfish-sha256");
  if (expectedSha256 === undefined || !/^[a-f\d]{64}$/iu.test(expectedSha256)) {
    throw new Error(
      "Provide the expected binary digest with --stockfish-sha256.",
    );
  }
  const stockfishSha256 = createHash("sha256")
    .update(readFileSync(stockfish))
    .digest("hex");
  if (stockfishSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Stockfish SHA-256 mismatch: expected ${expectedSha256.toLowerCase()}, received ${stockfishSha256}.`,
    );
  }
  const fen = valueAfter(arguments_, "--fen");
  const engineKindInput =
    valueAfter(arguments_, "--engine-kind") ?? "stockfish";
  if (
    engineKindInput !== "stockfish"
    && engineKindInput !== "fairy-stockfish"
  ) {
    throw new RangeError(
      "--engine-kind must be stockfish or fairy-stockfish.",
    );
  }
  const variantPathInput = valueAfter(arguments_, "--variant-path");
  if (
    engineKindInput === "fairy-stockfish"
    && variantPathInput === undefined
  ) {
    throw new Error(
      "Fairy-Stockfish requires the authenticated --variant-path.",
    );
  }
  if (
    engineKindInput === "stockfish"
    && variantPathInput !== undefined
  ) {
    throw new Error(
      "--variant-path is valid only with --engine-kind fairy-stockfish.",
    );
  }
  return {
    stockfish,
    stockfishSha256,
    engineKind: engineKindInput,
    depth: positiveInteger(valueAfter(arguments_, "--depth"), 2),
    leafDepth: positiveInteger(valueAfter(arguments_, "--leaf-depth"), 8),
    maxNodes: positiveInteger(valueAfter(arguments_, "--max-nodes"), 10_000),
    ...(variantPathInput === undefined
      ? {}
      : { variantPath: resolve(variantPathInput) }),
    ...(fen === undefined ? {} : { fen }),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const transport = new NodeProcessUciTransport({
    executablePath: options.stockfish,
  });
  const client = new UciClient(transport, {
    timeoutMs: 30_000,
    options: [
      { name: "Threads", value: 1 },
      { name: "Hash", value: 64 },
    ],
  });
  let fairyEvaluator:
    Awaited<ReturnType<typeof initializeFairyStockfishLeafEvaluator>>
    | null = null;
  try {
    const evaluator =
      options.engineKind === "fairy-stockfish"
        ? (
          fairyEvaluator = await initializeFairyStockfishLeafEvaluator({
            client,
            depth: options.leafDepth,
            variantPath: options.variantPath
              ?? failMissingFairyVariantPath(),
          })
        )
        : await initializeStockfishEvaluator(client, options.leafDepth);
    const identity = client.identity;
    if (identity === null) {
      throw new Error("UCI engine has no initialized identity.");
    }
    const session = DrawbackGameSession.create(
      {
        white: veganRule,
        black: checkersRule,
      },
      new Mulberry32(1),
      options.fen,
    );
    const result = await searchIterativeOmniscientDrawbackMove(
      session,
      evaluator,
      {
        maxDepth: options.depth,
        maxNodes: options.maxNodes,
        leafCacheHistoryMode: "ignore",
      },
    );
    console.log(
      "OFFLINE OMNISCIENT ORACLE — knows both drawbacks; not a player-private engine.",
    );
    console.log(
      `Engine: ${identity.name ?? "unknown"}; mode=${result.knowledgeMode}`,
    );
    console.log(`Executable: ${options.stockfish}`);
    console.log(`Executable SHA-256: ${options.stockfishSha256}`);
    console.log(
      `Position: ${session.fen}\nDrawbacks: White=Vegan, Black=Checkers`,
    );
    console.log(
      `Best offline oracle move: ${result.move.san} (${result.move.from}${result.move.to})`,
    );
    console.log(
      `Score: ${String(result.score)} cp; completedDepth=${String(result.completedDepth)}/${String(result.requestedDepth)}; nodes=${String(result.nodes)}; leaves=${String(result.leaves)}; truncated=${String(result.truncated)}`,
    );
    console.log(
      `Exact root scores: ${result.rootMoves.map((entry) =>
        `${entry.move.san}=${String(entry.score)}`
      ).join(", ")}`,
    );
    console.log(
      `Leaf cache: hits=${String(result.leafCache.hits)} misses=${String(result.leafCache.misses)} evictions=${String(result.leafCache.evictions)}`,
    );
    console.log(
      `PV: ${result.principalVariation.map((move) => move.san).join(" ")}`,
    );
  } finally {
    if (fairyEvaluator === null) {
      await client.close();
    } else {
      await fairyEvaluator.close();
    }
  }
}

async function initializeStockfishEvaluator(
  client: UciClient,
  depth: number,
) {
  await client.initialize();
  return createStockfishLeafEvaluator({ client, depth });
}

function failMissingFairyVariantPath(): never {
  throw new Error("Fairy-Stockfish variant path disappeared after validation.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown engine error.";
  console.error(`Drawback engine failed: ${message}`);
  process.exitCode = 1;
});
