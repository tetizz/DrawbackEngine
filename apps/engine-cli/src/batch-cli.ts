import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  simulateCatalogBatch,
} from "@drawbackengine/simulation-arena";
import { writeSimulationTraceNdjson } from "./simulation-output.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError("Game count and seed must be positive safe integers.");
  }
  return parsed;
}

function main(): void {
  const argumentsWithoutSeparator = process.argv
    .slice(2)
    .filter((argument) => argument !== "--");
  const games = positiveInteger(argumentsWithoutSeparator[0], 10);
  const seed = positiveInteger(argumentsWithoutSeparator[1], 1);
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
  const stream = createWriteStream(outputPath, {
    encoding: "utf8",
    flags: "wx",
  });
  stream.on("error", (error) => {
    console.error(`Game trace write failed: ${error.message}`);
    process.exitCode = 1;
  });
  const traces = writeSimulationTraceNdjson(batch, stream);
  stream.end(() => {
    console.log(
      `Wrote ${String(traces)} complete game traces to ${outputPath}`,
    );
  });
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown batch error.";
  console.error(`Batch simulation failed: ${message}`);
  process.exitCode = 1;
}
