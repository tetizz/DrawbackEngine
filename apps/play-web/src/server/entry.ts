import { fileURLToPath } from "node:url";
import {
  NodeUciLeafEvaluatorCloseError,
  createOwnedNodeUciLeafEvaluator,
  throwAfterSameOwnerCleanup,
  type OwnedNodeUciLeafEvaluator,
} from "@drawbackengine/chess-evaluator";
import { loadPlayEvaluatorConfig } from "./evaluator-config.js";
import { startPlayWebServer, type StartedPlayWebServer } from "./server.js";

const DEFAULT_PORT = 4173;

interface EntryOptions {
  readonly evaluatorConfig: string;
  readonly port: number;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const startup = new AbortController();
  let evaluator: OwnedNodeUciLeafEvaluator | null = null;
  let server: StartedPlayWebServer | null = null;
  const terminationState: { exitCode: 130 | 143 | null } = { exitCode: null };
  let resolveTermination: (() => void) | null = null;
  const termination = new Promise<void>((resolvePromise) => {
    resolveTermination = resolvePromise;
  });
  const requestShutdown = (exitCode: 130 | 143): void => {
    if (terminationState.exitCode !== null) {
      return;
    }
    terminationState.exitCode = exitCode;
    startup.abort(new DOMException("Local play is shutting down.", "AbortError"));
    resolveTermination?.();
  };
  const onSigint = (): void => { requestShutdown(130); };
  const onSigterm = (): void => { requestShutdown(143); };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let operationFailure: unknown;
  try {
    const loaded = await loadPlayEvaluatorConfig(options.evaluatorConfig);
    throwIfAborted(startup.signal);
    evaluator = await createOwnedNodeUciLeafEvaluator(loaded.config, {
      signal: startup.signal,
    });
    throwIfAborted(startup.signal);
    const handedOffEvaluator = evaluator;
    evaluator = null;
    server = await startPlayWebServer({
      port: options.port,
      staticRoot: fileURLToPath(new URL("../../client", import.meta.url)),
      evaluator: handedOffEvaluator,
      evaluatorMetadata: loaded.metadata,
      application: {
        reportInternalError(): void {
          process.stderr.write("A local engine request failed.\n");
        },
      },
    });
    throwIfAborted(startup.signal);
    process.stdout.write(
      `DrawbackEngine play is ready at ${server.url}\n`
        + `${loaded.metadata.name} ${loaded.metadata.version}; leaf depth ${String(loaded.metadata.leafDepth)}, Hash ${String(loaded.metadata.hashMb)} MB.\n`,
    );
    await termination;
  } catch (error: unknown) {
    operationFailure = error;
  }
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  let cleanupFailure: unknown;
  try {
    if (server !== null) {
      await server.close();
    } else if (evaluator !== null) {
      await closeUnhandedEvaluator(evaluator);
    }
  } catch (error: unknown) {
    cleanupFailure = error;
  }
  if (cleanupFailure !== undefined) {
    throw operationFailure === undefined
      ? errorFromUnknown(cleanupFailure)
      : new AggregateError(
          [operationFailure, cleanupFailure],
          "Local play stopped and cleanup encountered failures.",
        );
  }
  if (terminationState.exitCode !== null) {
    process.exitCode = terminationState.exitCode;
  }
  if (operationFailure !== undefined) {
    throw errorFromUnknown(operationFailure);
  }
}

function parseArguments(arguments_: readonly string[]): EntryOptions {
  const args = arguments_.filter((argument) => argument !== "--");
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: pnpm play:web -- --evaluator-config C:\\trusted\\fairy.json [--port 4173]\n",
    );
    process.exit(0);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      (name !== "--evaluator-config" && name !== "--port")
      || value === undefined
      || value.startsWith("--")
      || values.has(name)
    ) {
      throw new RangeError("Use --evaluator-config once and optionally --port once.");
    }
    values.set(name, value);
  }
  const evaluatorConfig = values.get("--evaluator-config");
  if (evaluatorConfig === undefined) {
    throw new RangeError("--evaluator-config is required.");
  }
  const portInput = values.get("--port");
  const port = portInput === undefined ? DEFAULT_PORT : Number(portInput);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new RangeError("--port must be an integer from 1024 through 65535.");
  }
  return Object.freeze({ evaluatorConfig, port });
}

void main().catch((error: unknown) => {
  if (process.exitCode === 130 || process.exitCode === 143) {
    return;
  }
  const message = error instanceof Error
    ? error.message.replaceAll(/[A-Za-z]:\\[^\r\n]*/gu, "<local path>")
    : "Unknown startup failure.";
  process.stderr.write(`Local play failed: ${message}\n`);
  process.exitCode = 1;
});

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  const reason: unknown = signal.reason;
  throw reason instanceof Error
    ? reason
    : new DOMException("Local play startup was aborted.", "AbortError");
}

async function closeUnhandedEvaluator(
  evaluator: OwnedNodeUciLeafEvaluator,
): Promise<void> {
  try {
    await evaluator.close();
  } catch (error: unknown) {
    if (evaluatorCleanupProvesComplete(error)) {
      throw error;
    }
    return throwAfterSameOwnerCleanup(
      error,
      () => evaluator.close(),
      "Local play startup evaluator cleanup remains incomplete.",
      evaluatorCleanupProvesComplete,
    );
  }
}

function evaluatorCleanupProvesComplete(error: unknown): boolean {
  return error instanceof NodeUciLeafEvaluatorCloseError
    && error.privateResourcesRemoved
    && error.processTerminated;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Local play failed with a non-Error value.", { cause: error });
}
