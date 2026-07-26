import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  simulateCatalogBatchParallel,
} from "@drawbackengine/simulation-arena";
import { writeSimulationTraceNdjsonFileAtomic } from "./simulation-output.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError("Games and workers must be positive safe integers.");
  }
  return parsed;
}

function unsignedSeed(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 0
    || parsed > 0xffff_ffff
  ) {
    throw new RangeError("Seed must be an unsigned 32-bit integer.");
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const games = positiveInteger(args[0], 100);
  const workers = positiveInteger(args[1], 4);
  const seed = unsignedSeed(args[2], 1);
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
  const written = await writeSimulationTraceNdjsonFileAtomic(
    outputPath,
    results,
  );
  console.log(
    `Wrote ${String(written.games)} ordered game traces (${String(written.bytes)} bytes, sha256 ${written.sha256}) using ${String(Math.min(games, workers))} workers to ${outputPath}`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown parallel error.";
  console.error(`Parallel simulation failed: ${message}`);
  process.exitCode = 1;
});
