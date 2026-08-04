import { resolve } from "node:path";
import {
  createOwnedNodeUciLeafEvaluator,
  type OwnedNodeUciLeafEvaluator,
} from "@drawbackengine/chess-evaluator";
import { drawbackMaterialEvaluator } from "@drawbackengine/drawback-search";
import {
  auditedUniformOpponentHypotheses,
  createPlayerPrivateAssignmentSchedule,
  runPlayerPrivateStrengthHarness,
  type PlayerPrivateGameAssignment,
  type PlayerPrivateStrengthEvaluatorKind,
  type PlayerPrivateStrengthParticipant,
  type PlayerPrivateStrengthReport,
} from "@drawbackengine/simulation-arena";
import { redactLocalPaths } from "./failure-redaction.js";
import { closeEvaluatorRuntime } from "./evaluator-runtime-cleanup.js";
import { loadPlayerPrivateEvaluatorPolicy } from "./player-private-evaluator-config.js";
import {
  findCleanupTerminationError,
  installTerminationSignal,
} from "./termination-signal.js";

interface EvaluatorRuntime {
  readonly kind: PlayerPrivateStrengthEvaluatorKind;
  readonly evaluator: PlayerPrivateStrengthParticipant["evaluator"];
  close(): Promise<void>;
}

interface CliOptions {
  readonly pairs: number;
  readonly candidateId: string;
  readonly candidateDepth: number;
  readonly candidateNodes: number;
  readonly baselineId: string;
  readonly baselineDepth: number;
  readonly baselineNodes: number;
  readonly maxPlies: number;
  readonly labelSeed: number;
  readonly gameplaySeed: number;
  readonly parameterSeed: number;
  readonly candidateEvaluator: "material" | "fairy-stockfish";
  readonly candidateEvaluatorConfig?: string;
  readonly baselineEvaluator: "material" | "fairy-stockfish";
  readonly baselineEvaluatorConfig?: string;
}

const termination = installTerminationSignal();

async function main(): Promise<void> {
  const options = parseOptions(
    process.argv.slice(2).filter((argument) => argument !== "--"),
  );
  const invocationDirectory = process.env["INIT_CWD"] ?? process.cwd();
  const runtimes: EvaluatorRuntime[] = [];
  let operation:
    | { readonly ok: true; readonly report: PlayerPrivateStrengthReport }
    | { readonly ok: false; readonly error: unknown };
  try {
    const candidate = await evaluatorRuntime(
      options.candidateEvaluator,
      options.candidateEvaluatorConfig,
      invocationDirectory,
    );
    runtimes.push(candidate);
    const baseline = await evaluatorRuntime(
      options.baselineEvaluator,
      options.baselineEvaluatorConfig,
      invocationDirectory,
    );
    runtimes.push(baseline);
    const assignments: PlayerPrivateGameAssignment[] = [];
    for (const scheduled of createPlayerPrivateAssignmentSchedule({
      splitCounts: { train: options.pairs, validation: 0, test: 0 },
      labelSeed: options.labelSeed,
      gameplaySeed: options.gameplaySeed,
      parameterSeed: options.parameterSeed,
    })) {
      termination.signal.throwIfAborted();
      assignments.push(scheduled.assignment);
    }
    const report = await runPlayerPrivateStrengthHarness({
      candidate: participant(
        options.candidateId,
        options.candidateDepth,
        options.candidateNodes,
        candidate,
      ),
      baseline: participant(
        options.baselineId,
        options.baselineDepth,
        options.baselineNodes,
        baseline,
      ),
      assignments,
      opponentHypotheses: auditedUniformOpponentHypotheses,
      maxPlies: options.maxPlies,
      signal: termination.signal,
    });
    operation = { ok: true, report };
  } catch (error: unknown) {
    operation = { ok: false, error };
  }

  const cleanupFailures: unknown[] = [];
  for (const runtime of [...runtimes].reverse()) {
    try {
      await closeEvaluatorRuntime(runtime);
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
  }
  if (!operation.ok && cleanupFailures.length > 0) {
    throw new AggregateError(
      [operation.error, ...cleanupFailures],
      "Strength match failed and evaluator cleanup was incomplete.",
    );
  }
  if (!operation.ok) {
    throw operation.error;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "Strength match completed but evaluator cleanup was incomplete.",
    );
  }
  console.log(JSON.stringify(operation.report, null, 2));
}

function participant(
  id: string,
  maxDepth: number,
  maxNodes: number,
  runtime: EvaluatorRuntime,
): PlayerPrivateStrengthParticipant {
  return Object.freeze({
    id,
    evaluatorKind: runtime.kind,
    evaluator: runtime.evaluator,
    limits: Object.freeze({
      maxDepth,
      maxNodes,
      leafCacheHistoryMode: "full" as const,
      signal: termination.signal,
    }),
    opponentAggregation: "worst-case" as const,
    temperature: Object.freeze({ temperatureCp: 1, topK: 1 }),
  });
}

async function evaluatorRuntime(
  mode: "material" | "fairy-stockfish",
  configPath: string | undefined,
  invocationDirectory: string,
): Promise<EvaluatorRuntime> {
  if (mode === "material") {
    if (configPath !== undefined) {
      throw new RangeError("Material evaluator mode does not accept a config path.");
    }
    return Object.freeze({
      kind: "material" as const,
      evaluator: drawbackMaterialEvaluator,
      close: () => Promise.resolve(),
    });
  }
  if (configPath === undefined) {
    throw new RangeError("Fairy-Stockfish mode requires an evaluator config path.");
  }
  const policy = await loadPlayerPrivateEvaluatorPolicy(
    resolve(invocationDirectory, configPath),
  );
  if (policy.kind !== "node-uci-leaf" || policy.config.kind !== "fairy-stockfish") {
    throw new TypeError("Strength matches accept Fairy-Stockfish, not orthodox Stockfish.");
  }
  const evaluator: OwnedNodeUciLeafEvaluator =
    await createOwnedNodeUciLeafEvaluator(
      policy.config,
      { signal: termination.signal },
    );
  return Object.freeze({
    kind: "fairy-stockfish" as const,
    evaluator,
    close: () => evaluator.close(),
  });
}

function parseOptions(args: readonly string[]): CliOptions {
  if (args.length < 7) {
    throw new RangeError(
      "Usage: <pairs> <candidate-id> <candidate-depth> <candidate-nodes> "
        + "<baseline-id> <baseline-depth> <baseline-nodes> "
        + "[max-plies] [label-seed] [gameplay-seed] [parameter-seed] "
        + "[candidate-evaluator] [candidate-config] "
        + "[baseline-evaluator] [baseline-config]",
    );
  }
  if (args.length > 15) {
    throw new RangeError("Strength CLI received unexpected trailing arguments.");
  }
  const candidateEvaluator = evaluatorMode(args[11] ?? "material");
  const baselineEvaluator = evaluatorMode(args[13] ?? "material");
  const candidateEvaluatorConfig = optionalConfig(args[12]);
  const baselineEvaluatorConfig = optionalConfig(args[14]);
  return Object.freeze({
    pairs: positiveInteger(requiredArgument(args, 0, "pairs"), "pairs"),
    candidateId: requiredId(args[1], "candidate ID"),
    candidateDepth: positiveInteger(
      requiredArgument(args, 2, "candidate depth"),
      "candidate depth",
    ),
    candidateNodes: nodeBudget(
      requiredArgument(args, 3, "candidate nodes"),
      "candidate nodes",
    ),
    baselineId: requiredId(args[4], "baseline ID"),
    baselineDepth: positiveInteger(
      requiredArgument(args, 5, "baseline depth"),
      "baseline depth",
    ),
    baselineNodes: nodeBudget(
      requiredArgument(args, 6, "baseline nodes"),
      "baseline nodes",
    ),
    maxPlies: positiveInteger(args[7] ?? "300", "max plies"),
    labelSeed: unsignedSeed(args[8] ?? "1369952257", "label seed"),
    gameplaySeed: unsignedSeed(args[9] ?? "1369952258", "gameplay seed"),
    parameterSeed: unsignedSeed(args[10] ?? "1369952259", "parameter seed"),
    candidateEvaluator,
    ...(candidateEvaluatorConfig === undefined
      ? {}
      : { candidateEvaluatorConfig }),
    baselineEvaluator,
    ...(baselineEvaluatorConfig === undefined
      ? {}
      : { baselineEvaluatorConfig }),
  });
}

function optionalConfig(value: string | undefined): string | undefined {
  return value === undefined || value === "-" ? undefined : value;
}

function requiredArgument(
  args: readonly string[],
  index: number,
  label: string,
): string {
  const value = args[index];
  if (value === undefined) {
    throw new RangeError(`${label} is required.`);
  }
  return value;
}

function evaluatorMode(value: string): "material" | "fairy-stockfish" {
  if (value !== "material" && value !== "fairy-stockfish") {
    throw new RangeError("Evaluator mode must be material or fairy-stockfish.");
  }
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function nodeBudget(value: string, label: string): number {
  const parsed = positiveInteger(value, label);
  if (parsed <= 1) {
    throw new RangeError(`${label} must be greater than one.`);
  }
  return parsed;
}

function unsignedSeed(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer.`);
  }
  return parsed;
}

function requiredId(value: string | undefined, label: string): string {
  if (
    value === undefined
    || value.length === 0
    || value.trim() !== value
    || /[\r\n\0]/u.test(value)
  ) {
    throw new RangeError(`${label} must be non-empty, trimmed, and single-line.`);
  }
  return value;
}

void main().catch((error: unknown) => {
  const raw = error instanceof Error ? error.message : "Unknown strength harness error.";
  console.error(JSON.stringify({
    kind: "player-private-strength-failure",
    message: redactLocalPaths(raw),
  }));
  process.exitCode = findCleanupTerminationError(error)?.exitCode ?? 1;
}).finally(() => {
  termination.dispose();
});
