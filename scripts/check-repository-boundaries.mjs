import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoots = ["apps", "packages"];
const forbiddenPatterns = [
  ["legacy package namespace", /@drawbacktrainer\//i],
  ["predictor package", /@drawbackengine\/predictor|packages[\\/]predictor/i],
  ["browser application", /apps[\\/]web/i],
  ["machine-learning workspace", /(?:^|[\\/])ml[\\/]/i],
  [
    "corpus or dataset module",
    /(?:from\s+|import\s*\()["'][^"']*(?:corpus|dataset)(?:-cli)?(?:\.[cm]?[jt]s)?["']/i,
  ],
];
const scanExtensions = new Set([".cjs", ".js", ".json", ".mjs", ".ts", ".tsx"]);
const expectedArenaFiles = new Set([
  "agents.test.ts",
  "agents.ts",
  "async-simulation.test.ts",
  "async-simulation.ts",
  "batch.test.ts",
  "batch.ts",
  "catalog.test.ts",
  "catalog.ts",
  "index.ts",
  "parallel.test.ts",
  "parallel-worker.ts",
  "parallel.ts",
  "parameterized-property.test.ts",
  "player-private-agent.ts",
  "player-private-assignment-scheduler.test.ts",
  "player-private-assignment-scheduler.ts",
  "player-private-catalog.test.ts",
  "player-private-catalog.ts",
  "player-private-parallel-protocol.ts",
  "player-private-parallel-worker.ts",
  "player-private-parallel.test.ts",
  "player-private-parallel.ts",
  "player-private-leaf-evaluator-protocol.ts",
  "player-private-remote-leaf-evaluator.test.ts",
  "player-private-remote-leaf-evaluator.ts",
  "player-private-result-validation.ts",
  "player-private-result-validation.test.ts",
  "player-private-scenarios.test.ts",
  "player-private-scenarios.ts",
  "player-private-simulation.test.ts",
  "player-private-simulation.ts",
  "player-private-stream.test.ts",
  "player-private-stream-lifecycle.test.ts",
  "player-private-stream.ts",
  "player-private-terminal-validation.ts",
  "player-private-trace.test.ts",
  "player-private-trace.ts",
  "player-private-uci-worker.test.ts",
  "player-private-worker-pool.test.ts",
  "player-private-worker-pool-hosted-cleanup.test.ts",
  "player-private-worker-pool.ts",
  "player-private-worker-protocol.ts",
  "player-private-worker-slot.ts",
  "player-private-worker-transport.ts",
  "prepared-catalog.test.ts",
  "prepared-catalog.ts",
  "prepared-parallel.test.ts",
  "property.test.ts",
  "random-streams.ts",
  "schema9-schedule.test.ts",
  "schema9-schedule.ts",
  "simulation.test.ts",
  "simulation.ts",
  "stockfish-agent.test.ts",
  "stockfish-agent.ts",
  "test-uci-config.ts",
  "trace.test.ts",
  "trace-json.ts",
  "trace.ts",
  "worker-retry.test.ts",
  "worker-retry.ts",
]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

function extensionOf(path) {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? "" : path.slice(lastDot);
}

const failures = [];
const forbiddenTrackedArtifactExtensions = new Set([
  ".ndjson",
  ".onnx",
  ".parquet",
  ".pt",
  ".sqlite",
  ".sqlite3",
]);
const trackedPaths = execFileSync("git", ["ls-files", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).split("\0").filter((path) => path.length > 0);
for (const trackedPath of trackedPaths) {
  const segments = trackedPath.split("/");
  if (
    segments.includes("node_modules")
    || segments.includes("dist")
    || segments.includes("__pycache__")
    || trackedPath.endsWith(".pyc")
    || forbiddenTrackedArtifactExtensions.has(extensionOf(trackedPath).toLowerCase())
  ) {
    failures.push(`${trackedPath} is a generated or private tracked artifact`);
  }
}
for (const sourceRoot of sourceRoots) {
  for (const path of await filesUnder(join(repositoryRoot, sourceRoot))) {
    if (!scanExtensions.has(extensionOf(path))) {
      continue;
    }
    const contents = await readFile(path, "utf8");
    for (const [description, pattern] of forbiddenPatterns) {
      if (pattern.test(contents)) {
        failures.push(`${relative(repositoryRoot, path)} contains ${description}`);
      }
    }
  }
}

const arenaDirectory = join(repositoryRoot, "packages", "simulation-arena", "src");
const actualArenaFiles = new Set(
  (await readdir(arenaDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name),
);
for (const file of actualArenaFiles) {
  if (!expectedArenaFiles.has(file)) {
    failures.push(`packages/simulation-arena/src/${file} is outside the reviewed engine-only arena boundary`);
  }
}
for (const file of expectedArenaFiles) {
  if (!actualArenaFiles.has(file)) {
    failures.push(`packages/simulation-arena/src/${file} is missing from the reviewed arena boundary`);
  }
}

const manifests = [
  "apps/engine-cli/package.json",
  "packages/chess-core/package.json",
  "packages/chess-evaluator/package.json",
  "packages/drawback-engine/package.json",
  "packages/drawback-search/package.json",
  "packages/probe-search/package.json",
  "packages/shared/package.json",
  "packages/simulation-arena/package.json",
  "packages/simulation-trace/package.json",
];
for (const manifestPath of manifests) {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, manifestPath), "utf8"));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  for (const dependency of Object.keys(dependencies)) {
    if (
      dependency === "@drawbackengine/predictor"
      || dependency === "@drawbackengine/simulation"
      || dependency.startsWith("@drawbacktrainer/")
    ) {
      failures.push(`${manifestPath} depends on forbidden package ${dependency}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Repository boundary validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Repository boundary validation passed.");
}
