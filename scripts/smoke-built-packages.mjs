import { access } from "node:fs/promises";
import { join } from "node:path";
import console from "node:console";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageChecks = [
  ["packages/shared/dist/index.js", "Mulberry32"],
  ["packages/drawback-engine/dist/index.js", "unrestrictedRule"],
  ["packages/chess-core/dist/index.js", "GameSession"],
  ["packages/probe-search/dist/index.js", "searchDiagnosticMoves"],
  ["packages/drawback-search/dist/index.js", "searchOmniscientDrawbackMove"],
  ["packages/chess-evaluator/dist/index.js", "UciClient"],
  ["packages/simulation-arena/dist/index.js", "simulateGame"],
];

for (const [relativePath, expectedExport] of packageChecks) {
  const absolutePath = join(repositoryRoot, relativePath);
  const module = await import(pathToFileURL(absolutePath).href);
  if (!(expectedExport in module)) {
    throw new Error(`${relativePath} does not export ${expectedExport}`);
  }
}

await access(join(repositoryRoot, "apps", "engine-cli", "dist", "cli.js"));
console.log("Built package smoke test passed.");
