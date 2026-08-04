import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticatedNodeUciEngineCloseError,
  createAuthenticatedNodeUciEngine,
} from "./authenticated-node-uci-engine.js";

const EXECUTABLE_DIGEST = createHash("sha256")
  .update(await readFile(process.execPath))
  .digest("hex");
const MARKERS: string[] = [];
const STALLING_UCI = String.raw`
const fs = require("node:fs");
fs.writeFileSync(process.argv[1], String(process.pid), "utf8");
process.stdin.resume();
setInterval(() => undefined, 1000);
`;

afterEach(async () => {
  await Promise.all(
    MARKERS.splice(0).map((path) => rm(path, { force: true })),
  );
});

describe("real authenticated UCI startup cancellation", () => {
  it("terminates the staged child and preserves the interruption reason", async () => {
    const marker = join(
      tmpdir(),
      `drawback-uci-startup-${randomUUID()}.txt`,
    );
    MARKERS.push(marker);
    const controller = new AbortController();
    const reason = new Error("Interrupt real UCI startup.");
    const started = createAuthenticatedNodeUciEngine(
      {
        process: {
          executablePath: process.execPath,
          executableSha256: EXECUTABLE_DIGEST,
          runtimeContextSha256: "b".repeat(64),
          args: ["-e", STALLING_UCI, marker],
          shutdownTimeoutMs: 100,
        },
        client: { timeoutMs: 10_000 },
        engineIdentity: {
          uciName: "Never Ready",
          engine: "real-stalling-test",
          version: "1",
        },
        optionsDigest: "a".repeat(64),
      },
      { signal: controller.signal },
    );

    await vi.waitUntil(async () => {
      try {
        await readFile(marker, "utf8");
        return true;
      } catch {
        return false;
      }
    }, { timeout: 5_000, interval: 20 });
    const pid = Number(await readFile(marker, "utf8"));
    controller.abort(reason);

    const failure = await started.catch((error: unknown) => error);
    expect(allFailures(failure)).toContain(reason);
    const cleanup = allFailures(failure).find(
      (error) => error instanceof AuthenticatedNodeUciEngineCloseError,
    );
    expect(cleanup).toMatchObject({
      privateExecutableRemoved: true,
      processTerminated: true,
    });
    await vi.waitFor(() => {
      expect(processIsAlive(pid)).toBe(false);
    }, { timeout: 5_000, interval: 20 });
  });
});

function allFailures(value: unknown): readonly unknown[] {
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  const failures: unknown[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    failures.push(current);
    if (current instanceof AggregateError) {
      pending.push(...current.errors as readonly unknown[]);
    }
    if (current instanceof Error && current.cause !== undefined) {
      pending.push(current.cause);
    }
  }
  return failures;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
