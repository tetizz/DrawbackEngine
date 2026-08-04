import type {
  DrawbackLeafEvaluator,
  LeafPosition,
} from "@drawbackengine/drawback-search";
import { UnsupportedDrawbackLeafPositionError } from "@drawbackengine/drawback-search";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import type { UciClient } from "./client.js";
import { throwAfterSameOwnerCleanup } from "./authenticated-node-uci-engine.js";
import { errorProvesUciProcessTerminated } from "./types.js";
import type {
  UciScore,
} from "./types.js";

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/u;
const MATE_SCORE = 900_000;

export const DRAWBACKCHESS_FAIRY_VARIANT = "drawbackchess";
/**
 * SHA-256 of the canonical LF UTF-8 bytes in
 * data/catalog/drawbackchess-fairy-v1.ini.
 */
export const DRAWBACKCHESS_FAIRY_VARIANT_SHA256 =
  "06f444eddf2f4b42ca55e50e317411b01509ee3178c95ec5fcaf26cbdde2a5b9";

export interface InitializeFairyStockfishLeafEvaluatorOptions {
  /**
   * Uninitialized borrowed client. Initialization and custom-variant loading
   * are performed atomically by initializeFairyStockfishLeafEvaluator().
   */
  readonly client: UciClient;
  readonly depth: number;
  readonly variantPath: string;
  readonly id?: string;
}

export interface InitializeAuthenticatedFairyStockfishLeafEvaluatorOptions {
  /** Initialized client whose exact executable and UCI identity are trusted. */
  readonly client: UciClient;
  readonly depth: number;
  readonly variant: {
    /** Caller-owned bytes copied before authentication. */
    readonly bytes: Uint8Array;
    /** Caller-pinned digest; never replaced with a measured digest. */
    readonly sha256: string;
  };
  readonly id?: string;
}

interface AuthenticatedFairyVariantConfig {
  readonly variantPath: string;
  readonly sha256: typeof DRAWBACKCHESS_FAIRY_VARIANT_SHA256;
  readonly bytes: Uint8Array;
}

interface PrivateFairyVariantConfig {
  readonly directoryPath: string;
  readonly variantPath: string;
}

interface FairyStockfishLeafRuntimeOptions {
  readonly client: UciClient;
  readonly depth: number;
}

export interface InitializedFairyStockfishLeafEvaluator
  extends DrawbackLeafEvaluator {
  close(): Promise<void>;
}

async function authenticateFairyStockfishVariantConfig(
  variantPath: string,
): Promise<AuthenticatedFairyVariantConfig> {
  validateVariantPath(variantPath);
  const resolvedPath = resolve(variantPath);
  await assertNoSymbolicLinkParents(resolvedPath);
  const metadata = await lstat(resolvedPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new FairyStockfishLeafEvaluatorError(
      "Fairy-Stockfish VariantPath must be a regular non-symlink file.",
    );
  }
  const canonicalPath = await realpath(resolvedPath);
  const canonicalMetadata = await lstat(canonicalPath);
  if (
    !canonicalMetadata.isFile()
    || canonicalMetadata.isSymbolicLink()
    || metadata.dev !== canonicalMetadata.dev
    || metadata.ino !== canonicalMetadata.ino
  ) {
    throw new FairyStockfishLeafEvaluatorError(
      "Fairy-Stockfish VariantPath changed while it was being authenticated.",
    );
  }
  const bytes = await readFile(canonicalPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== DRAWBACKCHESS_FAIRY_VARIANT_SHA256) {
    throw new FairyStockfishLeafEvaluatorError(
      "Fairy-Stockfish drawbackchess configuration bytes do not match the pinned digest.",
    );
  }
  const capability = Object.freeze({
    variantPath: canonicalPath,
    sha256: DRAWBACKCHESS_FAIRY_VARIANT_SHA256,
    bytes,
  });
  return capability;
}

export class UnsupportedFairyStockfishLeafError
  extends UnsupportedDrawbackLeafPositionError {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedFairyStockfishLeafError";
  }
}

export class FairyStockfishLeafEvaluatorError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FairyStockfishLeafEvaluatorError";
  }
}

export class FairyStockfishLeafEvaluatorCloseError extends Error {
  public constructor(
    message: string,
    public readonly privateVariantRemoved: boolean,
    public readonly processTerminated: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FairyStockfishLeafEvaluatorCloseError";
  }
}

function validateVariantPath(variantPath: string): void {
  if (
    variantPath.length === 0
    || variantPath.trim() !== variantPath
    || /[\r\n\0]/u.test(variantPath)
  ) {
    throw new RangeError(
      "Fairy-Stockfish VariantPath must be non-empty, trimmed, and single-line.",
    );
  }
}

/**
 * Authenticates and loads the optional Fairy-Stockfish heuristic in one
 * fail-closed operation.
 *
 * The source file is authenticated once and copied to a private, read-only
 * session path. Fairy loads only that copy behind a UCI readiness barrier.
 * The returned evaluator owns the borrowed client from that point onward;
 * close() shuts it down and removes the private artifact.
 */
export async function initializeFairyStockfishLeafEvaluator(
  options: InitializeFairyStockfishLeafEvaluatorOptions,
): Promise<InitializedFairyStockfishLeafEvaluator> {
  validateDepth(options.depth);
  const authenticatedBefore =
    await authenticateFairyStockfishVariantConfig(options.variantPath);
  return initializeFairyStockfishLeafEvaluatorFromBytes(
    options,
    authenticatedBefore.bytes,
    true,
  );
}

/**
 * Loads caller-pinned variant bytes into an already authenticated UCI process.
 * The evaluator owns the client after this call and always removes its private
 * configuration during close or failed initialization.
 */
export async function initializeAuthenticatedFairyStockfishLeafEvaluator(
  options: InitializeAuthenticatedFairyStockfishLeafEvaluatorOptions,
): Promise<InitializedFairyStockfishLeafEvaluator> {
  validateDepth(options.depth);
  const authenticatedBytes = authenticateFairyStockfishVariantBytes(
    options.variant.bytes,
    options.variant.sha256,
  );
  return initializeFairyStockfishLeafEvaluatorFromBytes(
    options,
    authenticatedBytes,
    false,
  );
}

async function initializeFairyStockfishLeafEvaluatorFromBytes(
  options: {
    readonly client: UciClient;
    readonly depth: number;
    readonly id?: string;
  },
  authenticatedBytes: Uint8Array,
  initializeClient: boolean,
): Promise<InitializedFairyStockfishLeafEvaluator> {
  const privateConfig =
    await materializePrivateVariantConfig(authenticatedBytes);
  try {
    if (initializeClient) {
      await options.client.initialize();
    }
    assertVariantOptionsAdvertised(options.client);
    await options.client.configureOptions([
      { name: "VariantPath", value: privateConfig.variantPath },
      {
        name: "UCI_Variant",
        value: DRAWBACKCHESS_FAIRY_VARIANT,
      },
    ]);
    const authenticatedAfter =
      await authenticateFairyStockfishVariantConfig(
        privateConfig.variantPath,
      );
    if (!sameFilesystemPath(
      authenticatedAfter.variantPath,
      privateConfig.variantPath,
    )) {
      throw new FairyStockfishLeafEvaluatorError(
        "Fairy-Stockfish private drawbackchess configuration changed while it was loading.",
      );
    }
    assertConfiguredVariant(
      options.client,
      privateConfig.variantPath,
    );
  } catch (error: unknown) {
    return throwAfterSameOwnerCleanup(
      error,
      () => closeFairyResources(options.client, privateConfig),
      "Fairy-Stockfish initialization failed and private cleanup encountered failures.",
      fairyCleanupProvesComplete,
    );
  }

  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let closePromise: Promise<void> | null = null;
  return {
    id:
      options.id
      ?? `fairy-stockfish/${DRAWBACKCHESS_FAIRY_VARIANT}/depth-${String(options.depth)}/${DRAWBACKCHESS_FAIRY_VARIANT_SHA256}`,
    evaluate(position, signal) {
      if (closed) {
        return Promise.reject(
          new FairyStockfishLeafEvaluatorError(
            "Fairy-Stockfish leaf evaluator is closed.",
          ),
        );
      }
      const task = queue.then(async () => {
        throwIfAborted(signal);
        return evaluateLeaf(options, position, signal);
      });
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
      const attempt = (async () => {
        await queue;
        await closeFairyResources(options.client, privateConfig);
      })();
      closePromise = attempt;
      void attempt.then(
        () => undefined,
        (error: unknown) => {
          if (
            closePromise === attempt
            && error instanceof FairyStockfishLeafEvaluatorCloseError
            && (
              !error.privateVariantRemoved
              || !error.processTerminated
            )
          ) {
            closePromise = null;
          }
        },
      );
      return attempt;
    },
  };
}

function authenticateFairyStockfishVariantBytes(
  suppliedBytes: Uint8Array,
  expectedSha256: string,
): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    throw new RangeError(
      "Fairy-Stockfish variant SHA-256 must be a lowercase digest.",
    );
  }
  if (expectedSha256 !== DRAWBACKCHESS_FAIRY_VARIANT_SHA256) {
    throw new FairyStockfishLeafEvaluatorError(
      "Fairy-Stockfish variant digest is not the supported drawbackchess digest.",
    );
  }
  const bytes = new Uint8Array(suppliedBytes);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new FairyStockfishLeafEvaluatorError(
      "Fairy-Stockfish variant bytes do not match the caller-pinned digest.",
    );
  }
  return bytes;
}

function validateDepth(depth: number): void {
  if (!Number.isSafeInteger(depth) || depth <= 0) {
    throw new RangeError(
      "Fairy-Stockfish leaf depth must be a positive integer.",
    );
  }
}

async function materializePrivateVariantConfig(
  bytes: Uint8Array,
): Promise<PrivateFairyVariantConfig> {
  const createdDirectoryPath = await mkdtemp(
    join(tmpdir(), "drawbackengine-fairy-"),
  );
  try {
    const directoryPath = await realpath(createdDirectoryPath);
    const variantPath = join(directoryPath, "drawbackchess.ini");
    await writeFile(variantPath, bytes, {
      flag: "wx",
      mode: 0o400,
    });
    await chmod(variantPath, 0o400);
    await chmod(directoryPath, 0o500);
    return Object.freeze({ directoryPath, variantPath });
  } catch (error: unknown) {
    return throwAfterSameOwnerCleanup(
      error,
      () => removePrivateVariantConfig({
        directoryPath: createdDirectoryPath,
        variantPath: join(createdDirectoryPath, "drawbackchess.ini"),
      }),
      "Fairy-Stockfish variant staging failed and private cleanup encountered failures.",
    );
  }
}

async function closeFairyResources(
  client: UciClient,
  privateConfig: PrivateFairyVariantConfig,
): Promise<void> {
  let clientFailure: unknown;
  let cleanupFailure: unknown;
  try {
    await client.close();
  } catch (error: unknown) {
    clientFailure = error;
  }
  try {
    await removePrivateVariantConfig(privateConfig);
  } catch (error: unknown) {
    cleanupFailure = error;
  }
  const failures = [clientFailure, cleanupFailure].filter(
    (failure) => failure !== undefined,
  );
  if (failures.length > 0) {
    const privateVariantRemoved = cleanupFailure === undefined;
    throw new FairyStockfishLeafEvaluatorCloseError(
      privateVariantRemoved
        ? "Fairy-Stockfish shutdown failed after private variant cleanup."
        : "Fairy-Stockfish shutdown or private variant cleanup failed.",
      privateVariantRemoved,
      clientFailure === undefined
        || errorProvesUciProcessTerminated(clientFailure),
      {
        cause:
          failures.length === 1
            ? failures[0]
            : new AggregateError(
                failures,
                "Fairy-Stockfish shutdown and private variant cleanup both failed.",
              ),
      },
    );
  }
}

function fairyCleanupProvesComplete(error: unknown): boolean {
  return error instanceof FairyStockfishLeafEvaluatorCloseError
    && error.privateVariantRemoved
    && error.processTerminated;
}

async function assertNoSymbolicLinkParents(
  resolvedPath: string,
): Promise<void> {
  const root = parse(resolvedPath).root;
  const segments = relative(root, resolvedPath).split(sep);
  let currentPath = root;
  for (const segment of segments.slice(0, -1)) {
    currentPath = join(currentPath, segment);
    if ((await lstat(currentPath)).isSymbolicLink()) {
      throw new FairyStockfishLeafEvaluatorError(
        "Fairy-Stockfish VariantPath cannot traverse a symbolic link.",
      );
    }
  }
}

async function removePrivateVariantConfig(
  config: PrivateFairyVariantConfig,
): Promise<void> {
  try {
    await chmod(config.directoryPath, 0o700);
    await chmod(config.variantPath, 0o600);
  } catch {
    // Cleanup below is authoritative and tolerates a partially created path.
  }
  await rm(config.directoryPath, { recursive: true, force: true });
}

async function evaluateLeaf(
  options: FairyStockfishLeafRuntimeOptions,
  position: LeafPosition,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (position.authorityId !== "capturable-king/v1") {
    throw new UnsupportedFairyStockfishLeafError(
      "Fairy-Stockfish drawback evaluation requires capturable-king/v1.",
    );
  }
  if (position.kingPassantActive) {
    throw new UnsupportedFairyStockfishLeafError(
      "Fairy-Stockfish cannot represent an active castling king-en-passant right.",
    );
  }
  const rootMoves = exactRootMoves(position);
  await options.client.reset(
    signal === undefined ? {} : { signal },
  );
  const evaluation = await options.client.evaluateFen(
    position.fen,
    { depth: options.depth },
    rootMoves,
    { ...(signal === undefined ? {} : { signal }) },
  );
  if (evaluation.bestMove === null) {
    throw new FairyStockfishLeafEvaluatorError(
      "Fairy-Stockfish returned no move for a non-terminal exact leaf request.",
    );
  }
  if (
    evaluation.depth === null
    || evaluation.depth < options.depth
  ) {
    throw new FairyStockfishLeafEvaluatorError(
      "Fairy-Stockfish did not complete the requested fixed-depth leaf search.",
    );
  }
  if (evaluation.score === null || evaluation.score.bound !== "exact") {
    throw new FairyStockfishLeafEvaluatorError(
      "Fairy-Stockfish did not return an exact score for the exact leaf request.",
    );
  }
  return normalizeScore(evaluation.score);
}

function exactRootMoves(position: LeafPosition): readonly string[] {
  const fenFields = position.fen.trim().split(/\s+/u);
  const expectedTurn = position.turn === "white" ? "w" : "b";
  if (fenFields.length !== 6 || fenFields[1] !== expectedTurn) {
    throw new UnsupportedFairyStockfishLeafError(
      "Fairy-Stockfish leaf FEN does not match its declared side to move.",
    );
  }
  if (position.legalMoves.length === 0) {
    throw new UnsupportedFairyStockfishLeafError(
      "Fairy-Stockfish requires a non-empty exact leaf root mask.",
    );
  }
  const moves = position.legalMoves.map((move) => {
    if (move.color !== position.turn) {
      throw new UnsupportedFairyStockfishLeafError(
        "Fairy-Stockfish leaf root has the wrong mover color.",
      );
    }
    const uci = `${move.from}${move.to}${promotionSymbol(move.promotion)}`;
    if (!UCI_MOVE.test(uci)) {
      throw new UnsupportedFairyStockfishLeafError(
        `Fairy-Stockfish leaf root is not canonical UCI: ${uci}.`,
      );
    }
    return uci;
  });
  const unique = new Set(moves);
  if (unique.size !== moves.length) {
    throw new UnsupportedFairyStockfishLeafError(
      "Fairy-Stockfish leaf root mask contains duplicate moves.",
    );
  }
  return Object.freeze([...unique].sort());
}

function assertVariantOptionsAdvertised(client: UciClient): void {
  const advertised = client.identity?.options ?? [];
  for (const required of ["VariantPath", "UCI_Variant"]) {
    const prefix = `option name ${required} `;
    if (!advertised.some((line) => line.startsWith(prefix))) {
      throw new FairyStockfishLeafEvaluatorError(
        `Initialized Fairy-Stockfish client does not advertise ${required}.`,
      );
    }
  }
}

function assertConfiguredVariant(
  client: UciClient,
  variantPath: string,
): void {
  if (client.configuredOption("UCI_Variant") !== DRAWBACKCHESS_FAIRY_VARIANT) {
    throw new FairyStockfishLeafEvaluatorError(
      "Initialized Fairy-Stockfish client did not select drawbackchess.",
    );
  }
  const configuredVariantPath = client.configuredOption("VariantPath");
  if (
    typeof configuredVariantPath !== "string"
    || !sameFilesystemPath(configuredVariantPath, variantPath)
  ) {
    throw new FairyStockfishLeafEvaluatorError(
      "Initialized Fairy-Stockfish client did not load the verified VariantPath.",
    );
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = normalize(resolve(left));
  const normalizedRight = normalize(resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function promotionSymbol(
  promotion: LeafPosition["legalMoves"][number]["promotion"],
): string {
  switch (promotion) {
    case undefined:
      return "";
    case "knight":
      return "n";
    case "bishop":
      return "b";
    case "rook":
      return "r";
    case "queen":
      return "q";
  }
}

function normalizeScore(score: UciScore): number {
  if (score.kind === "centipawns") {
    return score.value;
  }
  const distance = Math.min(Math.abs(score.moves), MATE_SCORE - 1);
  return score.moves >= 0
    ? MATE_SCORE - distance
    : -MATE_SCORE + distance;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException(
      "Fairy-Stockfish leaf evaluation was aborted.",
      "AbortError",
    );
  }
}
