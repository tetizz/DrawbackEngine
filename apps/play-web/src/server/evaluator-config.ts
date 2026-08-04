import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  deriveNodeUciLeafEvaluatorId,
  type NodeUciLeafEvaluatorConfig,
} from "@drawbackengine/chess-evaluator";
import type { PlayEvaluatorMetadata } from "../shared/api.js";

const SHA256 = /^[0-9a-f]{64}$/u;

export interface LoadedPlayEvaluatorConfig {
  readonly config: NodeUciLeafEvaluatorConfig;
  readonly metadata: PlayEvaluatorMetadata;
}

export async function loadPlayEvaluatorConfig(
  configPath: string,
): Promise<LoadedPlayEvaluatorConfig> {
  if (!isAbsolute(configPath)) {
    throw new RangeError("The evaluator configuration path must be absolute.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new Error("Unable to read or parse the evaluator configuration.", {
      cause: error,
    });
  }
  const input = record(parsed, "evaluator configuration");
  const kind = input["kind"];
  if (kind !== "fairy-stockfish") {
    throw new TypeError(
      "Browser play requires Fairy-Stockfish for capturable-king positions.",
    );
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
  expected.push("variantPath", "variantSha256");
  exactKeys(input, expected, "evaluator configuration");
  if (input["schemaVersion"] !== 1) {
    throw new TypeError("Evaluator configuration schemaVersion must be 1.");
  }
  const base = {
    kind,
    process: {
      executablePath: absolutePath(input["executablePath"], "executablePath"),
      executableSha256: digest(
        input["executableSha256"],
        "executableSha256",
      ),
      ...(input["args"] === undefined
        ? {}
        : { args: stringArray(input["args"], "args") }),
      cwd: absolutePath(input["cwd"], "cwd"),
      shutdownTimeoutMs: positiveInteger(
        input["shutdownTimeoutMs"],
        "shutdownTimeoutMs",
      ),
      runtimeContextSha256: digest(
        input["runtimeContextSha256"],
        "runtimeContextSha256",
      ),
    },
    client: {
      timeoutMs: positiveInteger(input["clientTimeoutMs"], "clientTimeoutMs"),
    },
    engineIdentity: {
      uciName: text(input["uciName"], "uciName"),
      engine: kind,
      version: text(input["version"], "version"),
      advertisedOptionsSha256: digest(
        input["advertisedOptionsSha256"],
        "advertisedOptionsSha256",
      ),
    },
    depth: positiveInteger(input["depth"], "depth"),
    hashMb: positiveInteger(input["hashMb"], "hashMb"),
    unsupportedPosition: "error" as const,
  };
  let bytes: Uint8Array;
  try {
    bytes = await readFile(absolutePath(input["variantPath"], "variantPath"));
  } catch (error: unknown) {
    throw new Error("Unable to read the Fairy-Stockfish variant file.", {
      cause: error,
    });
  }
  const config: NodeUciLeafEvaluatorConfig = {
    ...base,
    kind: "fairy-stockfish",
    fairyVariant: {
      bytes,
      sha256: digest(input["variantSha256"], "variantSha256"),
    },
  };
  try {
    deriveNodeUciLeafEvaluatorId(config);
  } catch (error: unknown) {
    throw new Error("The evaluator configuration failed authentication checks.", {
      cause: error,
    });
  }
  return Object.freeze({
    config,
    metadata: Object.freeze({
      kind: "Fairy-Stockfish",
      name: base.engineIdentity.uciName,
      version: base.engineIdentity.version,
      leafDepth: base.depth,
      hashMb: base.hashMb,
      threads: 1,
      multiPv: 1,
      limitStrength: false,
      skillLevel: 20,
      nnue: "disabled",
    }),
  });
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
      throw new TypeError(`${label} must contain single-line strings.`);
    }
    copied.push(item);
  }
  return Object.freeze(copied);
}
