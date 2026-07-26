import console from "node:console";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import {
  combinePosteriorBenchmarkReports,
} from "./posterior-benchmark-report.mjs";

const [
  inputArgument,
  startArgument,
  countArgument,
  plyArgument,
  depthArgument,
  nodesArgument,
  ...shardArguments
] = process.argv.slice(2);

if (
  inputArgument === undefined
  || startArgument === undefined
  || countArgument === undefined
  || plyArgument === undefined
  || depthArgument === undefined
  || nodesArgument === undefined
  || shardArguments.length === 0
) {
  throw new TypeError(
    "Usage: node scripts/combine-posterior-benchmark-shards.mjs "
      + "<input.ndjson> <start> <count> <ply> <depth> <nodes> "
      + "<shard.json> [...shard.json]",
  );
}

const shardRecords = [];
for (const argument of shardArguments) {
  const path = resolve(argument);
  const bytes = await readFile(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const text = bytes.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`${path} is not valid JSON.`, { cause: error });
  }
  shardRecords.push(parsed);
  console.error(`${path} sha256=${digest}`);
}

const report = combinePosteriorBenchmarkReports(shardRecords, {
  inputPath: resolve(inputArgument),
  startGameIndex: integer(startArgument, "start", 0),
  count: integer(countArgument, "count", 1),
  targetPly: integer(plyArgument, "ply", 0),
  depth: integer(depthArgument, "depth", 1),
  maxNodes: integer(nodesArgument, "nodes", 1),
});
console.log(JSON.stringify(report, null, 2));

function integer(value, name, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new RangeError(
      `${name} must be a safe integer at least ${String(minimum)}.`,
    );
  }
  return parsed;
}
