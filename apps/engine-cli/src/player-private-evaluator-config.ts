import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  deriveNodeUciLeafEvaluatorId,
  type NodeUciLeafEvaluatorConfig,
} from "@drawbackengine/chess-evaluator";
import type {
  PlayerPrivateEvaluatorPolicy,
} from "@drawbackengine/simulation-arena";

const SHA256 = /^[0-9a-f]{64}$/u;

export async function loadPlayerPrivateEvaluatorPolicy(
  configPath: string,
): Promise<PlayerPrivateEvaluatorPolicy> {
  if (!isAbsolute(configPath)) {
    throw new RangeError(
      "The private evaluator configuration path must be absolute.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new Error(
      "Unable to read or parse the private evaluator configuration.",
      { cause: error },
    );
  }
  const input = record(parsed, "evaluator configuration");
  const kind = input["kind"];
  if (kind !== "stockfish" && kind !== "fairy-stockfish") {
    throw new TypeError("Evaluator kind must be stockfish or fairy-stockfish.");
  }
  const expected = [
    "schemaVersion",
    "kind",
    "executablePath",
    "executableSha256",
    "cwd",
    "shutdownTimeoutMs",
    "runtimeContextSha256",
    "clientTimeoutMs",
    "uciName",
    "version",
    "advertisedOptionsSha256",
    "depth",
    "hashMb",
  ];
  if (input["args"] !== undefined) {
    expected.push("args");
  }
  if (kind === "fairy-stockfish") {
    expected.push("variantPath", "variantSha256");
  }
  exactKeys(input, expected, "evaluator configuration");
  if (input["schemaVersion"] !== 1) {
    throw new TypeError("Evaluator configuration schemaVersion must be 1.");
  }
  const executablePath = absolutePath(
    input["executablePath"],
    "executablePath",
  );
  const cwd = absolutePath(input["cwd"], "cwd");
  const executableSha256 = digest(
    input["executableSha256"],
    "executableSha256",
  );
  const advertisedOptionsSha256 = digest(
    input["advertisedOptionsSha256"],
    "advertisedOptionsSha256",
  );
  const processConfig = {
    executablePath,
    executableSha256,
    ...(input["args"] === undefined
      ? {}
      : { args: stringArray(input["args"], "args") }),
    cwd,
    shutdownTimeoutMs: positiveInteger(
      input["shutdownTimeoutMs"],
      "shutdownTimeoutMs",
    ),
    runtimeContextSha256: digest(
      input["runtimeContextSha256"],
      "runtimeContextSha256",
    ),
  };
  const base = {
    kind,
    process: processConfig,
    client: {
      timeoutMs: positiveInteger(
        input["clientTimeoutMs"],
        "clientTimeoutMs",
      ),
    },
    engineIdentity: {
      uciName: text(input["uciName"], "uciName"),
      engine: kind,
      version: text(input["version"], "version"),
      advertisedOptionsSha256,
    },
    depth: positiveInteger(input["depth"], "depth"),
    hashMb: positiveInteger(input["hashMb"], "hashMb"),
    unsupportedPosition: "error" as const,
  };
  let config: NodeUciLeafEvaluatorConfig;
  if (kind === "stockfish") {
    config = { ...base, kind: "stockfish" };
  } else {
    const variantPath = absolutePath(input["variantPath"], "variantPath");
    let bytes: Uint8Array;
    try {
      bytes = await readFile(variantPath);
    } catch (error: unknown) {
      throw new Error(
        "Unable to read the private Fairy-Stockfish variant configuration.",
        { cause: error },
      );
    }
    config = {
      ...base,
      kind: "fairy-stockfish",
      fairyVariant: {
        bytes,
        sha256: digest(input["variantSha256"], "variantSha256"),
      },
    };
  }
  let evaluatorId: string;
  try {
    evaluatorId = deriveNodeUciLeafEvaluatorId(config);
  } catch (error: unknown) {
    throw new Error(
      "The private evaluator configuration failed validation.",
      { cause: error },
    );
  }
  return {
    kind: "node-uci-leaf",
    version: 1,
    evaluatorId,
    config,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    throw new TypeError(`${label} has invalid fields.`);
  }
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\r\n\0]/u.test(value)
  ) {
    throw new TypeError(`${label} must be non-empty, trimmed text.`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = text(value, label);
  if (!isAbsolute(path)) {
    throw new RangeError(`${label} must be absolute.`);
  }
  return path;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of single-line strings.`);
  }
  const copied: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item !== "string" || /[\r\n\0]/u.test(item)) {
      throw new TypeError(
        `${label} must be an array of single-line strings.`,
      );
    }
    copied.push(item);
  }
  return copied;
}
