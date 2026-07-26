import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  simulateCatalogBatchParallel,
} from "@drawbackengine/simulation-arena";
import { writeSimulationTraceNdjson } from "./simulation-output.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError("games, workers, and seed must be positive safe integers.");
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const games = positiveInteger(args[0], 100);
  const workers = positiveInteger(args[1], 4);
  const seed = positiveInteger(args[2], 1);
  const invocationDirectory = process.env["INIT_CWD"] ?? process.cwd();
  const outputPath = resolve(
    invocationDirectory,
    args[3] ?? "data/parallel-game-traces.ndjson",
  );
  const results = await simulateCatalogBatchParallel({
    seed,
    games,
    workers,
    maxPlies: 240,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  const stream = createWriteStream(outputPath, {
    encoding: "utf8",
    flags: "wx",
  });
  stream.on("error", (error) => {
    console.error(`Parallel game trace write failed: ${error.message}`);
    process.exitCode = 1;
  });
  const traces = writeSimulationTraceNdjson(results, stream);
  stream.end(() => {
    console.log(
      `Wrote ${String(traces)} ordered game traces using ${String(Math.min(games, workers))} workers to ${outputPath}`,
    );
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown parallel error.";
  console.error(`Parallel simulation failed: ${message}`);
  process.exitCode = 1;
});
