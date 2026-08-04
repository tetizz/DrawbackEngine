import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlayEvaluatorConfig } from "./evaluator-config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("play evaluator configuration", () => {
  it("fails closed for orthodox Stockfish", async () => {
    const root = await mkdtemp(join(tmpdir(), "drawback-play-config-"));
    roots.push(root);
    const configPath = join(root, "stockfish.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      kind: "stockfish",
      executablePath: join(root, "stockfish.exe"),
      executableSha256: "a".repeat(64),
      cwd: root,
      shutdownTimeoutMs: 2_000,
      runtimeContextSha256: "b".repeat(64),
      clientTimeoutMs: 10_000,
      uciName: "Stockfish 18",
      version: "18",
      advertisedOptionsSha256: "c".repeat(64),
      depth: 8,
      hashMb: 128,
    }));

    await expect(loadPlayEvaluatorConfig(configPath)).rejects.toThrow(
      "requires Fairy-Stockfish",
    );
  });
});
