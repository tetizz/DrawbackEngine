import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPlayerPrivateEvaluatorPolicy,
} from "./player-private-evaluator-config.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("private player evaluator configuration", () => {
  it("loads an exact Stockfish policy without starting the engine", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "engine.json");
    await writeFile(path, JSON.stringify(await stockfishConfig()), "utf8");

    const policy = await loadPlayerPrivateEvaluatorPolicy(path);

    expect(policy.kind).toBe("node-uci-leaf");
    expect(
      policy.kind === "node-uci-leaf" ? policy.evaluatorId : "",
    ).toMatch(/^node-uci-leaf\/v1\/[0-9a-f]{64}$/u);
  });

  it("rejects extras and hides local paths from read failures", async () => {
    const directory = await temporaryDirectory();
    const extraPath = join(directory, "extra.json");
    await writeFile(extraPath, JSON.stringify({
      ...(await stockfishConfig()),
      unrestrictedFallback: true,
    }), "utf8");
    await expect(
      loadPlayerPrivateEvaluatorPolicy(extraPath),
    ).rejects.toThrow("invalid fields");

    const missingPath = join(
      directory,
      `private-${randomUUID()}.json`,
    );
    let message = "";
    try {
      await loadPlayerPrivateEvaluatorPolicy(missingPath);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "Unable to read or parse the private evaluator configuration.",
    );
    expect(message).not.toContain(directory);
    await expect(readFile(missingPath)).rejects.toThrow();
  });
});

async function stockfishConfig(): Promise<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    kind: "stockfish",
    executablePath: process.execPath,
    executableSha256: createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex"),
    cwd: process.cwd(),
    shutdownTimeoutMs: 2_000,
    runtimeContextSha256: "b".repeat(64),
    clientTimeoutMs: 5_000,
    uciName: "Pinned Test Engine",
    version: "test-v1",
    advertisedOptionsSha256: "1".repeat(64),
    depth: 4,
    hashMb: 64,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "drawback-evaluator-config-"),
  );
  cleanupDirectories.push(directory);
  return directory;
}
