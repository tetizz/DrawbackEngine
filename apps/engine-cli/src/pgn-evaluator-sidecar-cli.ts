import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
} from "node:fs";
import {
  dirname,
  resolve,
} from "node:path";
import {
  createNodeUciTurnConstraintProvider,
  serializeCompletedPgnEvaluatorSidecar,
  type NodeUciTurnConstraintProviderConfig,
} from "@drawbackengine/chess-evaluator";
import { writeUtf8FileAtomicNoClobber } from "./atomic-file.js";
import {
  generateCompletedPgnEvaluatorSidecarFromTrustedProvider,
} from "./pgn-evaluator-sidecar.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configuration(
  invocationDirectory: string,
): NodeUciTurnConstraintProviderConfig {
  const executablePath = resolve(
    invocationDirectory,
    requiredEnvironment("STOCKFISH_PATH"),
  );
  const executableSha256 = sha256Bytes(readFileSync(executablePath));
  const options = [
    { name: "Threads", value: 1 },
    { name: "Hash", value: 16 },
    { name: "Ponder", value: false },
    { name: "MultiPV", value: 1 },
    { name: "UCI_Chess960", value: false },
  ] as const;
  return {
    process: { executablePath, executableSha256 },
    client: { timeoutMs: 30_000, options },
    policy: {
      identity: { id: "stockfish-bestmove-v1", version: 1 },
      engineIdentity: {
        uciName: requiredEnvironment("STOCKFISH_UCI_NAME"),
        engine: "stockfish",
        version: requiredEnvironment("STOCKFISH_VERSION"),
      },
      optionsDigest: digest(options),
      limit: { nodes: 10_000 },
    },
  };
}

function decodeUtf8(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new TypeError(
      "Completed PGN input must be UTF-8 without a byte-order mark.",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError("Completed PGN input must be valid UTF-8.", {
      cause: error,
    });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
    throw new Error(
      "Usage: pnpm --filter @drawbackengine/cli pgn:evaluator-sidecar -- <completed.pgn> <output.sidecar.json>",
    );
  }
  const invocationDirectory = process.env["INIT_CWD"] ?? process.cwd();
  const pgnPath = resolve(invocationDirectory, args[0]);
  const outputPath = resolve(invocationDirectory, args[1]);
  mkdirSync(dirname(outputPath), { recursive: true });

  const pgn = decodeUtf8(readFileSync(pgnPath));
  const evaluator = configuration(invocationDirectory);
  const provider = await createNodeUciTurnConstraintProvider(evaluator);
  let generated;
  try {
    generated = await generateCompletedPgnEvaluatorSidecarFromTrustedProvider({
      pgn,
      evaluator,
      provider,
    });
  } finally {
    await provider.dispose();
  }

  const serialized = serializeCompletedPgnEvaluatorSidecar(
    generated.sidecar,
  );
  const exactByteSha256 = sha256Bytes(serialized);
  if (exactByteSha256 !== generated.sha256) {
    throw new Error("Canonical sidecar serialization digest mismatch.");
  }
  await writeUtf8FileAtomicNoClobber(outputPath, serialized);
  console.log(
    `Wrote ${String(generated.sidecar.plies.length)} evaluator facts to ${outputPath}; authenticate this artifact with SHA-256 ${exactByteSha256}.`,
  );
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown evaluator sidecar error.";
  console.error(`Evaluator sidecar generation failed: ${message}`);
  process.exitCode = 1;
});
