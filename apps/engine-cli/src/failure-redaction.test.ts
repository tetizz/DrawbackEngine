import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactLocalPaths } from "./failure-redaction.js";

describe("CLI failure redaction", () => {
  it.each([
    "failed at C:\\private\\engine.exe",
    "failed at C:/private/engine.exe",
    "failed at \\\\server\\private\\engine.exe",
    "failed at /home/private/engine",
    "failed at /secret",
    "failed at '/home/private folder/engine'",
    'failed at "C:\\private folder\\engine.exe"',
  ])("removes an absolute local path from %s", (message) => {
    const redacted = redactLocalPaths(message);
    expect(redacted).toContain("<local-path>");
    expect(redacted).not.toMatch(
      /(?:[A-Za-z]:[\\/]|\\\\server|\/(?:home\/private|secret))/u,
    );
  });

  it("does not damage web URLs or ordinary slash text", () => {
    const message = "See https://example.com/docs and train/validation/test.";
    expect(redactLocalPaths(message)).toBe(message);
  });

  it("reports an asynchronous private-output open failure as path-free JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drawback-cli-redaction-"));
    const privateFragment = `private-owner-${"x".repeat(300)}.ndjson`;
    const outputPath = join(directory, privateFragment);
    try {
      const result = await runPlayerPrivateCli(outputPath, directory);
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout.trim()).toBe("");
      const lines = result.stderr.trim().split(/\r?\n/u);
      expect(lines).toHaveLength(1);
      const failure = JSON.parse(lines[0] ?? "null") as unknown;
      if (typeof failure !== "object" || failure === null) {
        throw new TypeError("Expected a JSON failure object.");
      }
      const record = failure as Record<string, unknown>;
      expect(record["kind"]).toBe("player-private-failure");
      expect(record["message"]).toBeTypeOf("string");
      expect(record["message"]).toContain("<local-path>");
      expect(result.stderr).not.toContain(directory);
      expect(result.stderr).not.toContain(privateFragment);
      expect(result.stderr).not.toMatch(/uncaught|\n\s*at\s/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

async function runPlayerPrivateCli(
  outputPath: string,
  invocationDirectory: string,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const cliPath = fileURLToPath(
    new URL("./player-private-batch-cli.ts", import.meta.url),
  );
  const sourceLoader = new URL(
    "../node_modules/tsx/dist/loader.mjs",
    import.meta.url,
  ).href;
  const child = spawn(process.execPath, [
    "--import",
    sourceLoader,
    cliPath,
    "train",
    "1",
    "0",
    "0",
    "1",
    "1",
    "2",
    "3",
    outputPath,
    "1",
    "1",
    "1",
    "2000",
    "35",
    "standard",
    "material",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, INIT_CWD: invocationDirectory },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}
