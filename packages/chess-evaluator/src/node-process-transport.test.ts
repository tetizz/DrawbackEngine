import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  NodeProcessUciTransport,
  UciClient,
  UciProcessTerminationError,
  UciTransportError,
} from "./index.js";

const MOCK_ENGINE = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const command = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (command === "uci") {
      console.log("id name Spawned Mock");
      console.log("uciok");
    } else if (command === "isready") {
      console.log("readyok");
    } else if (command.startsWith("go ")) {
      console.log("info depth 2 nodes 10 score cp 7 pv e2e4");
      console.log("bestmove e2e4");
    } else if (command === "quit") {
      process.exit(0);
    }
  }
});
`;

describe("NodeProcessUciTransport", () => {
  it("runs a directly spawned UCI process through handshake, search, and shutdown", async () => {
    const transport = new NodeProcessUciTransport({
      executablePath: process.execPath,
      args: ["-e", MOCK_ENGINE],
    });
    const client = new UciClient(transport, { timeoutMs: 2_000 });

    await expect(client.initialize()).resolves.toMatchObject({
      name: "Spawned Mock",
    });
    await expect(
      client.evaluateFen(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        { depth: 2 },
        ["e2e4"],
      ),
    ).resolves.toMatchObject({
      bestMove: "e2e4",
      score: { kind: "centipawns", value: 7 },
    });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("rejects unsafe multiline commands before writing", async () => {
    const transport = new NodeProcessUciTransport({
      executablePath: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      shutdownTimeoutMs: 100,
    });
    await expect(transport.send("uci\nquit")).rejects.toThrow("single line");
    await expect(transport.close()).rejects.toThrow("did not exit");
  });

  it("classifies an unsolicited clean process exit as a transport failure", async () => {
    const transport = new NodeProcessUciTransport({
      executablePath: process.execPath,
      args: ["-e", "process.exit(0)"],
      shutdownTimeoutMs: 100,
    });
    const iterator = transport.lines()[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toBeInstanceOf(UciTransportError);
    await expect(transport.close()).rejects.toBeInstanceOf(UciTransportError);
  });

  it("surfaces a nonzero exit after a requested quit", async () => {
    const transport = new NodeProcessUciTransport({
      executablePath: process.execPath,
      args: [
        "-e",
        "process.stdin.once('data', () => process.exit(17))",
      ],
      shutdownTimeoutMs: 500,
    });

    await transport.send("quit");
    await expect(transport.close()).rejects.toThrow("code 17");
  });

  it("handles a child stdin failure without crashing or losing process cleanup", async () => {
    const uncaught: unknown[] = [];
    const observeUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", observeUncaught);
    const transport = new NodeProcessUciTransport({
      executablePath: process.execPath,
      args: ["-e", "process.exit(0)"],
      shutdownTimeoutMs: 50,
    });

    try {
      await expect(
        transport.send("x".repeat(16 * 1024 * 1024)),
      ).rejects.toBeInstanceOf(UciTransportError);
      await expect(transport.close()).rejects.toMatchObject({
        name: "UciProcessExitError",
        processTerminated: true,
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", observeUncaught);
    }
  }, 10_000);

  it("does not treat a post-spawn process error as proof of exit", async () => {
    const attemptedSignals: Array<NodeJS.Signals | number | undefined> = [];
    const spawnedChildren: ChildProcess[] = [];
    let postSpawnErrors = 0;
    const killSpy = vi
      .spyOn(ChildProcess.prototype, "kill")
      .mockImplementation(function (this: ChildProcess, signal) {
        attemptedSignals.push(signal);
        spawnedChildren.push(this);
        postSpawnErrors += 1;
        this.emit("error", new Error("synthetic post-spawn process error"));
        return false;
      });
    const transport = new NodeProcessUciTransport({
      executablePath: process.execPath,
      args: [
        "-e",
        'console.log("spawned"); setInterval(() => {}, 1_000)',
      ],
      shutdownTimeoutMs: 25,
    });

    try {
      const iterator = transport.lines()[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: "spawned",
      });

      const failure = await transport.close().then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(postSpawnErrors).toBe(2);
      expect(attemptedSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(failure).toBeInstanceOf(UciProcessTerminationError);
      expect(failure).toMatchObject({ processTerminated: false });
    } finally {
      killSpy.mockRestore();
      const child = spawnedChildren[0];
      if (
        child !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const exited = new Promise<void>((resolve) => {
          child.once("exit", () => {
            resolve();
          });
        });
        const killed = child.kill("SIGKILL");
        if (!killed && child.pid !== undefined) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            // The process may have exited between the state check and fallback.
          }
        }
        await exited;
        expect(killed).toBe(true);
      }
    }
  });
});
