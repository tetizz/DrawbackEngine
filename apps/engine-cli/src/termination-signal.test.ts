import { describe, expect, it } from "vitest";
import {
  CleanupTerminationError,
  findCleanupTerminationError,
  installTerminationSignal,
  type CleanupTerminationSignal,
  type TerminationSignalSource,
} from "./termination-signal.js";

class FakeSignalSource implements TerminationSignalSource {
  private readonly listeners = new Map<
    CleanupTerminationSignal,
    Set<() => void>
  >();

  public on(signal: CleanupTerminationSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  public removeListener(
    signal: CleanupTerminationSignal,
    listener: () => void,
  ): void {
    this.listeners.get(signal)?.delete(listener);
  }

  public emit(signal: CleanupTerminationSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) {
      listener();
    }
  }

  public listenerCount(): number {
    return [...this.listeners.values()].reduce(
      (count, listeners) => count + listeners.size,
      0,
    );
  }
}

describe("cooperative termination signals", () => {
  it("keeps the first signal reason and does not start duplicate aborts", () => {
    const source = new FakeSignalSource();
    const installed = installTerminationSignal(source);
    let aborts = 0;
    installed.signal.addEventListener("abort", () => {
      aborts += 1;
    });

    source.emit("SIGTERM");
    source.emit("SIGINT");

    expect(aborts).toBe(1);
    expect(installed.signal.reason).toMatchObject({
      signal: "SIGTERM",
      exitCode: 143,
    });
    installed.dispose();
    installed.dispose();
    expect(source.listenerCount()).toBe(0);
  });

  it("finds a termination reason through aggregate and cause chains", () => {
    const interruption = new CleanupTerminationError("SIGINT", 130);
    const wrapped = new AggregateError([
      new Error("Cleanup failed.", { cause: interruption }),
    ]);

    expect(findCleanupTerminationError(wrapped)).toBe(interruption);
  });
});
