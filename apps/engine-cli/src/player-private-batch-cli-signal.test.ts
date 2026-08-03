import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digestUciOptionDeclarations } from "@drawbackengine/chess-evaluator";
import { describe, expect, it } from "vitest";

type CatchableSignal = "SIGINT" | "SIGTERM";

const OPTION_DECLARATIONS = [
  "option name Threads type spin default 1 min 1 max 1",
  "option name Hash type spin default 16 min 1 max 4096",
  "option name Ponder type check default false",
  "option name MultiPV type spin default 1 min 1 max 500",
  "option name UCI_Chess960 type check default false",
  "option name UCI_LimitStrength type check default false",
  "option name Skill Level type spin default 20 min 0 max 20",
  "option name SyzygyPath type string default <empty>",
  "option name Clear Hash type button",
] as const;
const EXECUTABLE_SHA256 = createHash("sha256")
  .update(await readFile(process.execPath))
  .digest("hex");
const MOCK_UCI_ENGINE = String.raw`
const fs = require("node:fs");
const directory = process.argv[2];
const holdEnabledPath = process.argv[3];
const holdStartedPath = process.argv[4];
const logPath = process.argv[5];
const commands = [];
let buffer = "";
let pendingRoot = null;
let pendingDepth = null;
let pendingTimer = null;
const finishSearch = () => {
  pendingTimer = null;
  if (fs.existsSync(holdEnabledPath)) {
    fs.writeFileSync(holdStartedPath, "held");
    return;
  }
  console.log(
    "info depth " + pendingDepth + " nodes 10 score cp 0 pv " + pendingRoot,
  );
  console.log("bestmove " + pendingRoot);
  pendingRoot = null;
  pendingDepth = null;
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const command = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    commands.push(command);
    if (command === "uci") {
      console.log("id name Drawback CLI Signal Test");
      for (const option of ${JSON.stringify(OPTION_DECLARATIONS)}) {
        console.log(option);
      }
      console.log("uciok");
    } else if (command === "isready") {
      console.log("readyok");
    } else if (command.startsWith("go ")) {
      const roots = command.split(" searchmoves ")[1].split(" ");
      pendingRoot = roots[0];
      pendingDepth = command.match(/^go depth ([0-9]+)/)[1];
      pendingTimer = setTimeout(finishSearch, 40);
    } else if (command === "stop") {
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      pendingTimer = null;
      console.log(
        "info depth " + pendingDepth + " nodes 10 score cp 0 pv " + pendingRoot,
      );
      console.log("bestmove " + pendingRoot);
      pendingRoot = null;
      pendingDepth = null;
    } else if (command === "quit") {
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      fs.writeFileSync(
        logPath,
        JSON.stringify({ commands, executablePath: process.execPath }),
      );
      process.exit(0);
    }
  }
});
`;

describe("player-private CLI termination cleanup", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "removes private output after %s during active generation",
    async (signal, expectedExitCode) => {
      const directory = await mkdtemp(
        join(tmpdir(), "drawback-cli-signal-"),
      );
      const outputPath = join(directory, "private-output.ndjson");
      try {
        const result = await runInterruptedCli(
          outputPath,
          directory,
          signal,
        );
        expect(result.progressObserved).toBe(true);
        expect(result.code).toBe(expectedExitCode);
        expect(result.signal).toBeNull();
        expect(result.stdout).not.toContain("player-private-complete");
        expect(result.stderr).toContain("player-private-failure");
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "stops the owned UCI child and rolls back output after %s",
    async (signal, expectedExitCode) => {
      const directory = await mkdtemp(
        join(tmpdir(), "drawback-cli-uci-signal-"),
      );
      const outputPath = join(directory, "private-output.ndjson");
      const configPath = join(directory, "evaluator.json");
      const mockUciPath = join(directory, "mock-uci-engine.cjs");
      const holdEnabledPath = join(directory, "hold-enabled.marker");
      const holdStartedPath = join(directory, "hold-started.marker");
      const signalRequestPath = join(directory, "signal-request.marker");
      const logPath = join(directory, "engine-log.json");
      try {
        await writeFile(mockUciPath, MOCK_UCI_ENGINE, "utf8");
        await writeFile(configPath, JSON.stringify({
          schemaVersion: 1,
          kind: "stockfish",
          executablePath: process.execPath,
          executableSha256: EXECUTABLE_SHA256,
          args: [
            mockUciPath,
            directory,
            holdEnabledPath,
            holdStartedPath,
            logPath,
          ],
          cwd: process.cwd(),
          shutdownTimeoutMs: 2_000,
          runtimeContextSha256: "b".repeat(64),
          clientTimeoutMs: 5_000,
          uciName: "Drawback CLI Signal Test",
          version: "test-v1",
          advertisedOptionsSha256:
            digestUciOptionDeclarations(OPTION_DECLARATIONS),
          depth: 1,
          hashMb: 16,
        }), "utf8");

        const result = await runInterruptedUciCli({
          outputPath,
          configPath,
          invocationDirectory: directory,
          holdEnabledPath,
          holdStartedPath,
          signalRequestPath,
          signal,
        });

        expect(result.progressObserved).toBe(true);
        expect(result.heldSearchObserved).toBe(true);
        expect(result.code).toBe(expectedExitCode);
        expect(result.signal).toBeNull();
        expect(result.stdout).not.toContain("player-private-complete");
        expect(result.stderr).toContain("player-private-failure");
        await expect(access(outputPath)).rejects.toThrow();
        expect((await readdir(directory)).some((entry) =>
          entry.startsWith("private-output.ndjson.tmp-")
        )).toBe(false);

        const log = JSON.parse(await readFile(logPath, "utf8")) as {
          readonly commands: readonly string[];
          readonly executablePath: string;
        };
        expect(log.commands).toContain("stop");
        expect(log.commands.at(-1)).toBe("quit");
        expect(log.executablePath).not.toBe(process.execPath);
        await expect(access(log.executablePath)).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

async function runInterruptedCli(
  outputPath: string,
  invocationDirectory: string,
  signal: CatchableSignal,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly progressObserved: boolean;
}> {
  const cliUrl = pathToFileURL(fileURLToPath(
    new URL("./player-private-batch-cli.ts", import.meta.url),
  )).href;
  const sourceLoader = new URL(
    "../node_modules/tsx/dist/loader.mjs",
    import.meta.url,
  ).href;
  const wrapper = String.raw`
const cliUrl = process.argv[1];
const requestedSignal = process.argv[2];
process.argv = [process.execPath, cliUrl, ...process.argv.slice(3)];
if (process.platform === "win32") {
  const originalLog = console.log;
  let emitted = false;
  console.log = (...values) => {
    originalLog(...values);
    if (!emitted && values.some((value) =>
      String(value).includes("player-private-progress")
    )) {
      emitted = true;
      setImmediate(() => process.emit(requestedSignal));
    }
  };
}
await import(cliUrl);
`;
  const child = spawn(process.execPath, [
    "--import",
    sourceLoader,
    "--input-type=module",
    "--eval",
    wrapper,
    cliUrl,
    signal,
    "train",
    "200",
    "0",
    "0",
    "1",
    "101",
    "202",
    "303",
    outputPath,
    "120",
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
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  childStdout.setEncoding("utf8");
  childStderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let progressObserved = false;
  let interruptionSent = false;
  childStdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!interruptionSent && stdout.includes("player-private-progress")) {
      progressObserved = true;
      interruptionSent = true;
      if (process.platform !== "win32") {
        child.kill(signal);
      }
    }
  });
  childStderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(
        "Timed out waiting for interrupted CLI cleanup "
          + `(progress=${String(progressObserved)}, `
          + `stdoutBytes=${String(Buffer.byteLength(stdout))}, `
          + `stderrBytes=${String(Buffer.byteLength(stderr))}).`,
      ));
    }, 25_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timeout);
      resolve({
        code,
        signal: exitSignal,
        stdout,
        stderr,
        progressObserved,
      });
    });
  });
}

async function runInterruptedUciCli(input: {
  readonly outputPath: string;
  readonly configPath: string;
  readonly invocationDirectory: string;
  readonly holdEnabledPath: string;
  readonly holdStartedPath: string;
  readonly signalRequestPath: string;
  readonly signal: CatchableSignal;
}): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly progressObserved: boolean;
  readonly heldSearchObserved: boolean;
}> {
  const cliUrl = pathToFileURL(fileURLToPath(
    new URL("./player-private-batch-cli.ts", import.meta.url),
  )).href;
  const sourceLoader = new URL(
    "../node_modules/tsx/dist/loader.mjs",
    import.meta.url,
  ).href;
  const wrapper = String.raw`
const fs = await import("node:fs");
const cliUrl = process.argv[1];
const requestedSignal = process.argv[2];
const signalRequestPath = process.argv[3];
process.argv = [process.execPath, cliUrl, ...process.argv.slice(4)];
if (process.platform === "win32") {
  const poll = setInterval(() => {
    if (fs.existsSync(signalRequestPath)) {
      clearInterval(poll);
      process.emit(requestedSignal);
    }
  }, 5);
}
await import(cliUrl);
`;
  const child = spawn(process.execPath, [
    "--import",
    sourceLoader,
    "--input-type=module",
    "--eval",
    wrapper,
    cliUrl,
    input.signal,
    input.signalRequestPath,
    "train",
    "20",
    "0",
    "0",
    "1",
    "101",
    "202",
    "303",
    input.outputPath,
    "1",
    "1",
    "1",
    "2000",
    "35",
    "standard",
    "node-uci-leaf",
    input.configPath,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, INIT_CWD: input.invocationDirectory },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let progressObserved = false;
  let heldSearchObserved = false;
  let resolveProgress: (() => void) | undefined;
  const progress = new Promise<void>((resolve) => {
    resolveProgress = resolve;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!progressObserved && stdout.includes("player-private-progress")) {
      progressObserved = true;
      resolveProgress?.();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error(
          "Timed out waiting for interrupted UCI CLI cleanup "
            + `(progress=${String(progressObserved)}, `
            + `held=${String(heldSearchObserved)}, `
            + `stdoutBytes=${String(Buffer.byteLength(stdout))}, `
            + `stderrBytes=${String(Buffer.byteLength(stderr))}, `
            + `stderr=${JSON.stringify(stderr)}).`,
        ));
      }
    }, 50_000);
    void (async () => {
      await progress;
      await writeFile(input.holdEnabledPath, "hold", "utf8");
      await waitForPath(input.holdStartedPath);
      heldSearchObserved = true;
      if (process.platform === "win32") {
        await writeFile(input.signalRequestPath, input.signal, "utf8");
      } else if (!child.kill(input.signal)) {
        throw new Error(`Unable to deliver ${input.signal} to the CLI child.`);
      }
    })().catch((error: unknown) => {
      child.kill("SIGKILL");
      if (!settled) {
        clearTimeout(timeout);
        settled = true;
        reject(errorFromUnknown(error));
      }
    });
    child.once("error", (error) => {
      if (!settled) {
        clearTimeout(timeout);
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code, exitSignal) => {
      if (!settled) {
        clearTimeout(timeout);
        settled = true;
        resolve({
          code,
          signal: exitSignal,
          stdout,
          stderr,
          progressObserved,
          heldSearchObserved,
        });
      }
    });
  });
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("A test operation failed with a non-Error value.", {
        cause: error,
      });
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the mock UCI held-search marker.");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
}
