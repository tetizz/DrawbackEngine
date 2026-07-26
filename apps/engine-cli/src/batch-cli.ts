import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  simulateCatalogBatch,
} from "@drawbackengine/simulation-arena";
import { writeSimulationTraceNdjsonFileAtomic } from "./simulation-output.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError("Game count must be a positive safe integer.");
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
  const argumentsWithoutSeparator = process.argv
    .slice(2)
    .filter((argument) => argument !== "--");
  const games = positiveInteger(argumentsWithoutSeparator[0], 10);
  const seed = unsignedSeed(argumentsWithoutSeparator[1], 1);
  const invocationDirectory = process.env["INIT_CWD"] ?? process.cwd();
  const outputPath = resolve(
    invocationDirectory,
    argumentsWithoutSeparator[2] ?? "data/game-traces.ndjson",
  );
  const batch = simulateCatalogBatch({
    seed,
    games,
    maxPlies: 200,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  const written = await writeSimulationTraceNdjsonFileAtomic(outputPath, batch);
  console.log(
    `Wrote ${String(written.games)} complete game traces (${String(written.bytes)} bytes, sha256 ${written.sha256}) to ${outputPath}`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown batch error.";
  console.error(`Batch simulation failed: ${message}`);
  process.exitCode = 1;
});
