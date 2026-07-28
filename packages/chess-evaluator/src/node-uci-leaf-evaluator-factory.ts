import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type {
  DrawbackLeafEvaluator,
  LeafPosition,
} from "@drawbackengine/drawback-search";
import {
  createAuthenticatedNodeUciEngine,
  type SerializableUciEngineIdentity,
} from "./authenticated-node-uci-engine.js";
import {
  DRAWBACKCHESS_FAIRY_VARIANT_SHA256,
  initializeAuthenticatedFairyStockfishLeafEvaluator,
} from "./fairy-stockfish-leaf-evaluator.js";
import type { NodeProcessTransportOptions } from "./node-process-transport.js";
import { createStockfishLeafEvaluator } from "./stockfish-leaf-evaluator.js";
import type { UciOptionSetting } from "./types.js";

const FACTORY_FORMAT = "drawback-node-uci-leaf/v1";

interface NodeUciLeafEvaluatorConfigBase {
  readonly process: NodeProcessTransportOptions & {
    /** Exact caller-pinned executable digest. */
    readonly executableSha256: string;
    /** Explicit absolute runtime directory; inherited cwd is not accepted. */
    readonly cwd: string;
    /** Explicit process shutdown deadline included in run provenance. */
    readonly shutdownTimeoutMs: number;
  };
  readonly client: {
    /** Explicit protocol deadline included in run provenance. */
    readonly timeoutMs: number;
  };
  readonly engineIdentity: SerializableUciEngineIdentity & {
    /** Exact digest of all ordered UCI `option ...` declarations. */
    readonly advertisedOptionsSha256: string;
  };
  readonly depth: number;
  /** Fixed transposition-table size for the lifetime of this process. */
  readonly hashMb: number;
  /** Unsupported public positions are always explicit errors. */
  readonly unsupportedPosition: "error";
}

export interface NodeStockfishLeafEvaluatorConfig
  extends NodeUciLeafEvaluatorConfigBase {
  readonly kind: "stockfish";
  readonly fairyVariant?: never;
}

export interface NodeFairyStockfishLeafEvaluatorConfig
  extends NodeUciLeafEvaluatorConfigBase {
  readonly kind: "fairy-stockfish";
  readonly fairyVariant: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
  };
}

export type NodeUciLeafEvaluatorConfig =
  | NodeStockfishLeafEvaluatorConfig
  | NodeFairyStockfishLeafEvaluatorConfig;

export interface OwnedNodeUciLeafEvaluator extends DrawbackLeafEvaluator {
  close(): Promise<void>;
}

export class NodeUciLeafEvaluatorFactoryError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeUciLeafEvaluatorFactoryError";
  }
}

/**
 * Purely validates caller-pinned configuration and derives the exact public
 * evaluator ID. It does not inspect executable bytes, spawn a process, or
 * substitute measured values for caller expectations.
 */
export function deriveNodeUciLeafEvaluatorId(
  input: NodeUciLeafEvaluatorConfig,
): string {
  return deriveValidatedIdentity(validateAndCopyConfig(input)).id;
}

/**
 * Starts one authenticated long-lived UCI process and exposes it only as a
 * drawback leaf scorer. The UCI process receives public FEN/root moves, never
 * drawback IDs, parameters, hidden state, or private move history.
 */
export async function createOwnedNodeUciLeafEvaluator(
  input: NodeUciLeafEvaluatorConfig,
): Promise<OwnedNodeUciLeafEvaluator> {
  const config = validateAndCopyConfig(input);
  const derived = deriveValidatedIdentity(config);
  const engine = await createAuthenticatedNodeUciEngine({
    process: config.process,
    client: {
      timeoutMs: config.timeoutMs,
      options: derived.fixedOptions,
    },
    engineIdentity: config.engineIdentity,
    optionsDigest: derived.runtimeConfigDigest,
    advertisedOptionsSha256:
      config.engineIdentity.advertisedOptionsSha256,
  });

  if (config.kind === "stockfish") {
    const evaluator = createStockfishLeafEvaluator({
      client: engine.client,
      depth: config.depth,
      id: derived.id,
    });
    return ownBorrowedEvaluator(evaluator, () => engine.close());
  }

  try {
    return await initializeAuthenticatedFairyStockfishLeafEvaluator({
      client: engine.client,
      depth: config.depth,
      variant: config.fairyVariant,
      id: derived.id,
    });
  } catch (error: unknown) {
    await engine.close().catch(() => undefined);
    throw error;
  }
}

type ValidatedConfig =
  & {
    readonly process: NodeProcessTransportOptions & {
      readonly executableSha256: string;
      readonly cwd: string;
      readonly shutdownTimeoutMs: number;
    };
    readonly engineIdentity:
      & SerializableUciEngineIdentity
      & { readonly advertisedOptionsSha256: string };
    readonly depth: number;
    readonly hashMb: number;
    readonly timeoutMs: number;
    readonly unsupportedPosition: "error";
  }
  & (
    | { readonly kind: "stockfish" }
    | {
        readonly kind: "fairy-stockfish";
        readonly fairyVariant: {
          readonly bytes: Uint8Array;
          readonly sha256: typeof DRAWBACKCHESS_FAIRY_VARIANT_SHA256;
        };
      }
  );

function validateAndCopyConfig(
  input: NodeUciLeafEvaluatorConfig,
): ValidatedConfig {
  const unchecked: {
    readonly kind: unknown;
    readonly unsupportedPosition: unknown;
    readonly fairyVariant?: unknown;
  } = input;
  if (unchecked.unsupportedPosition !== "error") {
    throw new NodeUciLeafEvaluatorFactoryError(
      "Node UCI leaf evaluators require unsupportedPosition=error.",
    );
  }
  if (
    unchecked.kind !== "stockfish"
    && unchecked.kind !== "fairy-stockfish"
  ) {
    throw new NodeUciLeafEvaluatorFactoryError(
      "Unsupported Node UCI leaf engine kind.",
    );
  }
  const depth = positiveInteger(input.depth, "Node UCI leaf depth");
  const hashMb = positiveInteger(input.hashMb, "Node UCI leaf Hash");
  const timeoutMs = positiveInteger(
    input.client.timeoutMs,
    "Node UCI leaf client timeout",
  );
  const processConfig = {
    executablePath: requiredAbsolutePath(
      input.process.executablePath,
      "UCI executable path",
    ),
    executableSha256: sha256Digest(
      input.process.executableSha256,
      "UCI executable SHA-256",
    ),
    ...(input.process.args === undefined
      ? {}
      : { args: input.process.args.map(processArgument) }),
    cwd: requiredAbsolutePath(
      input.process.cwd,
      "UCI process working directory",
    ),
    shutdownTimeoutMs: positiveInteger(
      input.process.shutdownTimeoutMs,
      "UCI shutdown timeout",
    ),
  };
  const engineIdentity = {
    uciName: requiredText(
      input.engineIdentity.uciName,
      "Expected UCI engine name",
    ),
    engine: fingerprintComponent(
      input.engineIdentity.engine,
      "Engine fingerprint name",
    ),
    version: fingerprintComponent(
      input.engineIdentity.version,
      "Engine fingerprint version",
    ),
    advertisedOptionsSha256: sha256Digest(
      input.engineIdentity.advertisedOptionsSha256,
      "Advertised UCI options SHA-256",
    ),
  };
  if (engineIdentity.engine !== unchecked.kind) {
    throw new NodeUciLeafEvaluatorFactoryError(
      "Node UCI leaf engine provenance does not match its selected engine kind.",
    );
  }

  if (input.kind === "stockfish") {
    if (unchecked.fairyVariant !== undefined) {
      throw new NodeUciLeafEvaluatorFactoryError(
        "Stockfish leaf configuration cannot include Fairy variant bytes.",
      );
    }
    return {
      kind: "stockfish",
      process: processConfig,
      engineIdentity,
      depth,
      hashMb,
      timeoutMs,
      unsupportedPosition: "error",
    };
  }
  const fairyVariant = authenticateFairyVariant(input.fairyVariant);
  return {
    kind: "fairy-stockfish",
    process: processConfig,
    engineIdentity,
    depth,
    hashMb,
    timeoutMs,
    unsupportedPosition: "error",
    fairyVariant,
  };
}

function fixedUciOptions(
  kind: ValidatedConfig["kind"],
  hashMb: number,
): readonly UciOptionSetting[] {
  const common: UciOptionSetting[] = [
    Object.freeze({ name: "Threads", value: 1 }),
    Object.freeze({ name: "Hash", value: hashMb }),
    Object.freeze({ name: "Ponder", value: false }),
    Object.freeze({ name: "MultiPV", value: 1 }),
    Object.freeze({ name: "UCI_Chess960", value: false }),
    Object.freeze({ name: "UCI_LimitStrength", value: false }),
    Object.freeze({ name: "Skill Level", value: 20 }),
    Object.freeze({ name: "SyzygyPath", value: "<empty>" }),
  ];
  if (kind === "fairy-stockfish") {
    common.push(Object.freeze({ name: "Use NNUE", value: false }));
  }
  common.push(
    Object.freeze({ name: "Clear Hash" }),
  );
  return Object.freeze(common);
}

interface DerivedNodeUciLeafIdentity {
  readonly id: string;
  readonly fixedOptions: readonly UciOptionSetting[];
  readonly fixedOptionsDigest: string;
  readonly runtimeConfigDigest: string;
}

function deriveValidatedIdentity(
  config: ValidatedConfig,
): DerivedNodeUciLeafIdentity {
  const fixedOptions = fixedUciOptions(config.kind, config.hashMb);
  const fixedOptionsDigest = digestFixedUciOptions(fixedOptions);
  const runtimeConfigDigest = digestLeafConfiguration(
    config,
    fixedOptionsDigest,
  );
  return Object.freeze({
    id: publicEvaluatorId(
      config,
      fixedOptionsDigest,
      runtimeConfigDigest,
    ),
    fixedOptions,
    fixedOptionsDigest,
    runtimeConfigDigest,
  });
}

function digestFixedUciOptions(
  fixedOptions: readonly UciOptionSetting[],
): string {
  const canonicalOptions = fixedOptions.map((option) =>
    option.value === undefined
      ? [option.name]
      : [option.name, option.value]
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalOptions), "utf8")
    .digest("hex");
}

function digestLeafConfiguration(
  config: ValidatedConfig,
  fixedOptionsDigest: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      format: FACTORY_FORMAT,
      kind: config.kind,
      process: {
        executablePath: config.process.executablePath,
        args: config.process.args ?? [],
        cwd: config.process.cwd,
        shutdownTimeoutMs: config.process.shutdownTimeoutMs,
      },
      client: {
        timeoutMs: config.timeoutMs,
      },
      fixedOptionsDigest,
      depth: config.depth,
      fairyVariantSha256:
        config.kind === "fairy-stockfish"
          ? config.fairyVariant.sha256
          : null,
      unsupportedPosition: config.unsupportedPosition,
    }), "utf8")
    .digest("hex");
}

function publicEvaluatorId(
  config: ValidatedConfig,
  fixedOptionsDigest: string,
  runtimeConfigDigest: string,
): string {
  const engineDigest = createHash("sha256")
    .update(JSON.stringify({
      adapterVersion: FACTORY_FORMAT,
      kind: config.kind,
      executableSha256: config.process.executableSha256,
      uciName: config.engineIdentity.uciName,
      engineFamily: config.engineIdentity.engine,
      engineVersion: config.engineIdentity.version,
      advertisedOptionsSha256:
        config.engineIdentity.advertisedOptionsSha256,
      fixedOptionsDigest,
      runtimeConfigDigest,
      depth: config.depth,
      fairyVariantSha256:
        config.kind === "fairy-stockfish"
          ? config.fairyVariant.sha256
          : null,
      unsupportedPosition: config.unsupportedPosition,
    }), "utf8")
    .digest("hex");
  return `node-uci-leaf/v1/${engineDigest}`;
}

function ownBorrowedEvaluator(
  evaluator: DrawbackLeafEvaluator,
  closeEngine: () => Promise<void>,
): OwnedNodeUciLeafEvaluator {
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let closePromise: Promise<void> | null = null;
  return {
    id: evaluator.id,
    evaluate(position: LeafPosition, signal?: AbortSignal) {
      if (closed) {
        return Promise.reject(
          new NodeUciLeafEvaluatorFactoryError(
            "Node UCI leaf evaluator is closed.",
          ),
        );
      }
      const task = queue.then(() => evaluator.evaluate(position, signal));
      queue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    close() {
      if (closePromise !== null) {
        return closePromise;
      }
      closed = true;
      closePromise = (async () => {
        await queue;
        await closeEngine();
      })();
      return closePromise;
    },
  };
}

function authenticateFairyVariant(
  variant: NodeFairyStockfishLeafEvaluatorConfig["fairyVariant"],
): {
  readonly bytes: Uint8Array;
  readonly sha256: typeof DRAWBACKCHESS_FAIRY_VARIANT_SHA256;
} {
  const expectedSha256 = sha256Digest(
    variant.sha256,
    "Fairy variant SHA-256",
  );
  if (expectedSha256 !== DRAWBACKCHESS_FAIRY_VARIANT_SHA256) {
    throw new NodeUciLeafEvaluatorFactoryError(
      "Fairy variant digest is not the supported drawbackchess digest.",
    );
  }
  const bytes = new Uint8Array(variant.bytes);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new NodeUciLeafEvaluatorFactoryError(
      "Fairy variant bytes do not match the caller-pinned digest.",
    );
  }
  return Object.freeze({
    bytes,
    sha256: DRAWBACKCHESS_FAIRY_VARIANT_SHA256,
  });
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  if (
    value.length === 0
    || value.trim() !== value
    || /[\r\n\0]/u.test(value)
  ) {
    throw new RangeError(`${label} must be non-empty, trimmed, and single-line.`);
  }
  return value;
}

function requiredAbsolutePath(value: unknown, label: string): string {
  const path = requiredText(value, label);
  if (!isAbsolute(path)) {
    throw new RangeError(`${label} must be absolute.`);
  }
  const normalized = normalize(path);
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function fingerprintComponent(value: unknown, label: string): string {
  const component = requiredText(value, label);
  if (component.includes(":")) {
    throw new RangeError(
      `${label} must not contain the public fingerprint delimiter (:).`,
    );
  }
  return component;
}

function processArgument(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("UCI process arguments must be strings.");
  }
  if (value.includes("\0")) {
    throw new RangeError("UCI process arguments must not contain NUL.");
  }
  return value;
}

function sha256Digest(value: unknown, label: string): string {
  const digest = requiredText(value, label);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new RangeError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return digest;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}
