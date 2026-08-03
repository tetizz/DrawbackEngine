import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Writable } from "node:stream";
import {
  createSchema9PlayerPrivateBundle,
  parseSchema9PlayerPrivateCliArguments,
  verifiedCleanEngineCommit,
  type Schema9PlayerPrivateBundleDependencies,
} from "./schema9-player-private-bundle.js";
import { redactLocalPaths } from "./failure-redaction.js";
import { writeJsonLine } from "./json-line-writer.js";
import { retryRetainedCleanup } from "./retained-cleanup.js";
import {
  findCleanupTerminationError,
  installTerminationSignal,
} from "./termination-signal.js";

const PROGRESS_INTERVAL_GAMES = 10;

export interface Schema9PlayerPrivateCliDependencies {
  readonly arguments?: readonly string[];
  readonly invocationDirectory?: string;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly verifyCleanCommit?: typeof verifiedCleanEngineCommit;
  readonly bundleDependencies?: Schema9PlayerPrivateBundleDependencies;
}

export async function runSchema9PlayerPrivateCli(
  dependencies: Schema9PlayerPrivateCliDependencies = {},
): Promise<void> {
  const termination = installTerminationSignal();
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    const arguments_ = (dependencies.arguments ?? process.argv.slice(2)).filter(
      (argument) => argument !== "--",
    );
    const invocationDirectory = dependencies.invocationDirectory
      ?? process.env["INIT_CWD"]
      ?? process.cwd();
    const options = parseSchema9PlayerPrivateCliArguments(
      arguments_,
      invocationDirectory,
    );
    const verifyCleanCommit = dependencies.verifyCleanCommit
      ?? verifiedCleanEngineCommit;
    const producerEngineCommit = await verifyCleanCommit(
      options.engineRepository,
    );
    const result = await createSchema9PlayerPrivateBundle({
      ledgerSplit: options.ledgerSplit,
      games: options.games,
      workers: options.workers,
      scheduleId: options.scheduleId,
      bundlePath: options.bundlePath,
      producerEngineCommit,
      signal: termination.signal,
      onProgress: async ({ games, bytes }) => {
        if (
          games !== 1
          && games !== options.games
          && games % PROGRESS_INTERVAL_GAMES !== 0
        ) {
          return;
        }
        await writeJsonLine(stdout, {
          kind: "schema9-player-private-progress",
          ledgerSplit: options.ledgerSplit,
          scheduleId: options.scheduleId,
          games,
          totalGames: options.games,
          bytes,
        }, termination.signal);
      },
    }, dependencies.bundleDependencies);
    await writeJsonLine(stdout, {
      kind: "schema9-player-private-complete",
      ...result,
    });
  } catch (error: unknown) {
    const reported = await retryRetainedCleanup(error, 2);
    const message = redactLocalPaths(
      reported instanceof Error
        ? reported.message
        : "Unknown schema-9 generation error.",
    );
    await writeJsonLine(stderr, {
      kind: "schema9-player-private-failure",
      message,
    }).catch(() => undefined);
    process.exitCode = findCleanupTerminationError(reported)?.exitCode ?? 1;
  } finally {
    termination.dispose();
  }
}

function isDirectInvocation(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined
    && pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

if (isDirectInvocation()) {
  void runSchema9PlayerPrivateCli();
}
