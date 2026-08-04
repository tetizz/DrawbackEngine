import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type CatchableSignal = "SIGINT" | "SIGTERM";

const COMMIT = "a".repeat(40);
const REPOSITORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("schema-9 CLI child-process lifecycle", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "rolls back the private bundle after %s",
    async (signal, expectedCode) => {
      const root = await mkdtemp(join(tmpdir(), "schema9-cli-signal-test-"));
      const bundlePath = join(root, "bundle");
      try {
        const result = await runChild({
          mode: "signal",
          bundlePath,
          signal,
        });

        expect(result.progressObserved).toBe(true);
        expect(result.code).toBe(expectedCode);
        expect(result.signal).toBeNull();
        expect(result.stdout).not.toContain("schema9-player-private-complete");
        expect(result.stderr).toContain("schema9-player-private-failure");
        expect(await readdir(root)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("rolls back after a broken progress destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-cli-epipe-test-"));
    const bundlePath = join(root, "bundle");
    try {
      const result = await runChild({
        mode: "epipe",
        bundlePath,
      });

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stdout).not.toContain("schema9-player-private-complete");
      expect(result.stderr).toContain("schema9-player-private-failure");
      expect(await readdir(root)).toEqual([]);
      await expect(access(bundlePath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

async function runChild(input: {
  readonly mode: "signal" | "epipe";
  readonly bundlePath: string;
  readonly signal?: CatchableSignal;
}): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly progressObserved: boolean;
}> {
  const cliUrl = pathToFileURL(fileURLToPath(
    new URL("./schema9-player-private-cli.ts", import.meta.url),
  )).href;
  const sourceLoader = new URL(
    "../node_modules/tsx/dist/loader.mjs",
    import.meta.url,
  ).href;
  const wrapper = String.raw`
const marker = process.argv[1];
const cliUrl = process.argv[2];
const mode = process.argv[3];
const requestedSignal = process.argv[4];
const commit = process.argv[5];
const { runSchema9PlayerPrivateCli } = await import(cliUrl);
const { createHash } = await import("node:crypto");
const { writeFile } = await import("node:fs/promises");
const runtimeIdentity = Object.freeze({
  format: "drawbackengine-schema9-producer-runtime",
  version: 1,
  algorithm: "sha256-engine-runtime-tree-v1",
  runtime: Object.freeze({
    nodeVersion: "v22.17.0",
    platform: "win32",
    architecture: "x64",
    execArgv: Object.freeze([]),
  }),
  coordinator: Object.freeze({
    componentId: "schema9-coordinator/v1",
    files: 17,
    bytes: 1234,
    sha256: "${"1".repeat(64)}",
  }),
  parallelWorker: Object.freeze({
    componentId: "player-private-parallel-worker/v1",
    files: 13,
    bytes: 987,
    sha256: "${"2".repeat(64)}",
  }),
  aggregateSha256: "8ae516a9c7dd38ec645f79036806fceb9f75e9e4860426d53b83befee5a0347d",
});
let stdout;
if (mode === "epipe") {
  const { Writable } = await import("node:stream");
  stdout = new Writable({
    write(_chunk, _encoding, callback) {
      const failure = new Error("injected EPIPE");
      failure.code = "EPIPE";
      callback(failure);
    },
  });
} else if (process.platform === "win32") {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let emitted = false;
  process.stdout.write = (chunk, ...rest) => {
    const accepted = originalWrite(chunk, ...rest);
    if (!emitted && String(chunk).includes("schema9-player-private-progress")) {
      emitted = true;
      setImmediate(() => process.emit(requestedSignal));
    }
    return accepted;
  };
}
await runSchema9PlayerPrivateCli({
  arguments: process.argv.slice(6),
  invocationDirectory: process.cwd(),
  ...(stdout === undefined ? {} : { stdout }),
  verifyCleanCommit: async () => commit,
  attestProducerRuntime: async () => runtimeIdentity,
  bundleDependencies: {
    verifyProducerCommit: async () => commit,
    verifyProducerRuntimeIdentity: async () => runtimeIdentity,
    runBatch: async (options) => {
      const trace = Buffer.from("{\"lifecycle\":true}\n", "utf8");
      await writeFile(options.outputPath, trace, { flag: "wx" });
      await options.onProgress?.({
        split: "train",
        games: 1,
        bytes: trace.length,
      });
      if (options.signal?.aborted === true) {
        throw options.signal.reason;
      }
      await new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(options.signal.reason);
        }, { once: true });
      });
      return {
        split: "train",
        games: 25,
        firstGameIndex: 0,
        lastGameIndex: 24,
        bytes: trace.length,
        sha256: createHash("sha256").update(trace).digest("hex"),
        evaluatorId: "drawback-material/v1",
        profile: {
          id: "standard",
          policyId: "material-player-private-corpus/v1",
        },
        generationConfig: {
          maxPlies: 120,
          maxDepth: 2,
          maxNodes: 50000,
          temperatureCp: 35,
          topK: 8,
          leafCacheEntries: 16384,
          leafCacheHistoryMode: "full",
          opponentAggregation: "worst-case",
          evaluator: {
            kind: "material",
            version: 1,
            evaluatorId: "drawback-material/v1",
          },
          opponentHypotheses: {
            kind: "unrestricted-baseline",
            version: 1,
          },
        },
      };
    },
  },
});
void marker;
`;
  const child = spawn(process.execPath, [
    "--import",
    sourceLoader,
    "--input-type=module",
    "--eval",
    wrapper,
    "schema9-test-wrapper",
    cliUrl,
    input.mode,
    input.signal ?? "",
    COMMIT,
    "--ledger-split",
    "train",
    "--games",
    "25",
    "--workers",
    "1",
    "--schedule-id",
    "schema9-lifecycle-v1",
    "--bundle",
    input.bundlePath,
    "--engine-repository",
    REPOSITORY,
  ], {
    cwd: REPOSITORY,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let progressObserved = false;
  let signalSent = false;
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (
      input.mode === "signal"
      && !signalSent
      && stdout.includes("schema9-player-private-progress")
    ) {
      progressObserved = true;
      signalSent = true;
      if (process.platform !== "win32" && input.signal !== undefined) {
        child.kill(input.signal);
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((accept, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(
        "Timed out waiting for Schema-9 CLI lifecycle cleanup "
          + `(progress=${String(progressObserved)}, `
          + `stdoutBytes=${String(Buffer.byteLength(stdout))}, `
          + `stderrBytes=${String(Buffer.byteLength(stderr))}).`,
      ));
    }, 50_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timeout);
      accept({
        code,
        signal: exitSignal,
        stdout,
        stderr,
        progressObserved,
      });
    });
  });
}
