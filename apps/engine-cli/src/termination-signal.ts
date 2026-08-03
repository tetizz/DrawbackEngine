export type CleanupTerminationSignal = "SIGINT" | "SIGTERM";

export class CleanupTerminationError extends Error {
  public constructor(
    public readonly signal: CleanupTerminationSignal,
    public readonly exitCode: number,
  ) {
    super(`Player-private generation was interrupted by ${signal}.`);
    this.name = "CleanupTerminationError";
  }
}

export interface InstalledTerminationSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

export interface TerminationSignalSource {
  on(signal: CleanupTerminationSignal, listener: () => void): void;
  removeListener(
    signal: CleanupTerminationSignal,
    listener: () => void,
  ): void;
}

/** Converts catchable termination signals into one cooperative cleanup. */
export function installTerminationSignal(
  source: TerminationSignalSource = process,
): InstalledTerminationSignal {
  const controller = new AbortController();
  const onInterrupt = (): void => {
    abortOnce(controller, "SIGINT", 130);
  };
  const onTerminate = (): void => {
    abortOnce(controller, "SIGTERM", 143);
  };
  source.on("SIGINT", onInterrupt);
  source.on("SIGTERM", onTerminate);
  let disposed = false;
  return {
    signal: controller.signal,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      source.removeListener("SIGINT", onInterrupt);
      source.removeListener("SIGTERM", onTerminate);
    },
  };
}

export function findCleanupTerminationError(
  value: unknown,
): CleanupTerminationError | undefined {
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof CleanupTerminationError) {
      return current;
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors as readonly unknown[]);
    }
    if (current instanceof Error && current.cause !== undefined) {
      pending.push(current.cause);
    }
  }
  return undefined;
}

function abortOnce(
  controller: AbortController,
  signal: CleanupTerminationSignal,
  exitCode: number,
): void {
  if (!controller.signal.aborted) {
    controller.abort(new CleanupTerminationError(signal, exitCode));
  }
}
