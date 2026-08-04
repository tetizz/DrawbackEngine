import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import {
  NodeUciLeafEvaluatorCloseError,
  createOwnedNodeUciLeafEvaluator,
  throwAfterSameOwnerCleanup,
  type OwnedNodeUciLeafEvaluator,
} from "@drawbackengine/chess-evaluator";
import {
  PLAYER_PRIVATE_RULE_IDS,
  PlayerPrivatePlayGame,
  type PlayerPlayAction,
  type PlayerPlayObservationV1,
  type PlayerPrivateEngineMove,
  type PlayerPrivatePlayOptions,
  type PlayerPrivatePlayReveal,
  type PlayerPrivateRuleId,
  type PlayerVisibleMove,
} from "@drawbackengine/simulation-arena";
import type { PlayerColor } from "@drawbackengine/shared";
import {
  loadPlayerPrivateEvaluatorPolicy,
} from "./player-private-evaluator-config.js";

const DEFAULT_SEED = 1;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_NODES = 50_000;
const MAX_UNSIGNED_32_BIT_INTEGER = 0xffff_ffff;

export const PLAYER_PRIVATE_PLAY_USAGE = `DrawbackEngine local play

Usage:
  pnpm --filter @drawbackengine/cli play -- \\
    --evaluator-config C:\\trusted\\fairy-stockfish.json \\
    --human-color white --human-drawback vegan --seed 12345 \\
    --max-depth 2 --max-nodes 50000

Options:
  --evaluator-config  Absolute authenticated evaluator JSON path (required)
  --human-color       white or black (default: white)
  --human-drawback    one audited drawback ID or random (default: random)
  --seed              unsigned 32-bit game seed (default: 1)
  --max-depth         exact outer search target (default: 2)
  --max-nodes         exact outer search budget (default: 50000)
  --initial-fen       optional trusted capturable-king starting FEN
  --help              show this message

Move input:
  e2-e4, e7-e8=Q, board, moves, drawback, help, resign, quit`;

export interface PlayerPrivatePlayTerminal {
  writeLine(line?: string): void;
  question(prompt: string, signal: AbortSignal): Promise<string>;
  close(): void;
}

export interface PlayerPrivatePlayCliDependencies {
  readonly arguments?: readonly string[];
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signal?: AbortSignal;
  readonly terminal?: PlayerPrivatePlayTerminal;
  readonly loadEvaluatorPolicy?: typeof loadPlayerPrivateEvaluatorPolicy;
  readonly createEvaluator?: typeof createOwnedNodeUciLeafEvaluator;
  readonly createGame?: typeof PlayerPrivatePlayGame.create;
}

export type PlayerPrivatePlayCliResult =
  | { readonly kind: "completed"; readonly plies: number }
  | { readonly kind: "resigned"; readonly plies: number }
  | { readonly kind: "quit"; readonly plies: number }
  | { readonly kind: "help"; readonly plies: 0 };

interface ParsedPlayOptions {
  readonly help: boolean;
  readonly evaluatorConfig?: string;
  readonly seed: number;
  readonly humanColor: PlayerColor;
  readonly humanDrawbackId?: PlayerPrivateRuleId;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly initialFen?: string;
}

interface ParsedCoordinateMove {
  readonly from: string;
  readonly to: string;
  readonly promotion?: "knight" | "bishop" | "rook" | "queen";
}

type OperationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error };

export async function runPlayerPrivatePlayCli(
  dependencies: PlayerPrivatePlayCliDependencies = {},
): Promise<PlayerPrivatePlayCliResult> {
  const options = parsePlayOptions(
    dependencies.arguments ?? process.argv.slice(2),
  );
  const output = dependencies.output ?? process.stdout;
  if (options.help) {
    output.write(`${PLAYER_PRIVATE_PLAY_USAGE}\n`);
    return Object.freeze({ kind: "help", plies: 0 });
  }
  const signal = dependencies.signal ?? new AbortController().signal;
  const terminal = dependencies.terminal ?? createNodeTerminal(
    dependencies.input ?? process.stdin,
    output,
  );
  try {
    throwIfAborted(signal);
    const policy = await (
      dependencies.loadEvaluatorPolicy ?? loadPlayerPrivateEvaluatorPolicy
    )(options.evaluatorConfig ?? missingEvaluatorConfig());
    throwIfAborted(signal);
    if (
      policy.kind !== "node-uci-leaf"
      || policy.config.kind !== "fairy-stockfish"
    ) {
      throw new Error(
        "Local capturable-king play requires an authenticated Fairy-Stockfish evaluator.",
      );
    }
    const evaluator = await (
      dependencies.createEvaluator ?? createOwnedNodeUciLeafEvaluator
    )(policy.config, { signal });
    return await runWithOwnedPlayEvaluator(evaluator, async () => {
      throwIfAborted(signal);
      const gameOptions: PlayerPrivatePlayOptions = {
        seed: options.seed,
        humanColor: options.humanColor,
        ...(options.humanDrawbackId === undefined
          ? {}
          : { humanDrawbackId: options.humanDrawbackId }),
        ...(options.initialFen === undefined
          ? {}
          : { initialFen: options.initialFen }),
      };
      const game = (dependencies.createGame ?? PlayerPrivatePlayGame.create)(
        gameOptions,
      );
      try {
        return await runPlayerPrivatePlayLoop(
          game,
          evaluator,
          terminal,
          signal,
          options.maxDepth,
          options.maxNodes,
        );
      } catch (error: unknown) {
        if (signal.aborted) {
          throw abortReason(signal);
        }
        throw error;
      }
    });
  } finally {
    terminal.close();
  }
}

export async function runPlayerPrivatePlayLoop(
  game: PlayerPrivatePlayGame,
  evaluator: OwnedNodeUciLeafEvaluator,
  terminal: PlayerPrivatePlayTerminal,
  signal: AbortSignal,
  maxDepth: number,
  maxNodes: number,
): Promise<PlayerPrivatePlayCliResult> {
  let renderedPly = -1;
  terminal.writeLine("DrawbackEngine local player-private game");
  terminal.writeLine(
    "The engine knows only its own exact drawback and public hypotheses about yours.",
  );
  terminal.writeLine(
    `Engine setting: target depth ${String(maxDepth)}, `
      + `node cap ${String(maxNodes)}; evaluator ${evaluator.id}.`,
  );
  renderOwnDrawback(terminal, game.observation());

  for (;;) {
    throwIfAborted(signal);
    const observation = game.observation();
    if (observation.ply !== renderedPly) {
      renderBoard(terminal, observation);
      renderedPly = observation.ply;
    }
    if (observation.status.kind !== "active") {
      renderStatus(terminal, observation);
      renderReveal(terminal, game.reveal());
      return Object.freeze({ kind: "completed", plies: observation.ply });
    }
    if (observation.turn !== game.humanColor) {
      terminal.writeLine("Engine is thinking...");
      const move = await game.playEngineTurn(evaluator, {
        maxDepth,
        maxNodes,
        signal,
      });
      renderEngineMove(terminal, move);
      continue;
    }

    const answer = (
      await terminal.question("Your move (e2-e4, help): ", signal)
    ).trim();
    const command = answer.toLowerCase();
    if (command === "help") {
      terminal.writeLine(
        "Commands: e2-e4, e7-e8=Q, board, moves, drawback, resign, quit.",
      );
      continue;
    }
    if (command === "board") {
      renderBoard(terminal, observation);
      continue;
    }
    if (command === "moves") {
      renderMoves(terminal, observation.actions);
      continue;
    }
    if (command === "drawback") {
      renderOwnDrawback(terminal, observation);
      continue;
    }
    if (command === "quit") {
      terminal.writeLine("Game closed without revealing the hidden drawback.");
      return Object.freeze({ kind: "quit", plies: observation.ply });
    }
    if (command === "resign") {
      const resigned = game.resignHuman();
      renderStatus(terminal, resigned);
      renderReveal(terminal, game.reveal());
      return Object.freeze({ kind: "resigned", plies: resigned.ply });
    }

    const requested = parseCoordinateMove(answer);
    if (requested === null) {
      terminal.writeLine(
        "Enter a coordinate move such as e2-e4 or e7-e8=Q, or type help.",
      );
      continue;
    }
    const action = observation.actions.find((candidate) =>
      sameVisibleMove(candidate, requested)
    );
    if (action === undefined) {
      terminal.writeLine("That action is unavailable in the current position.");
      continue;
    }
    const submitted = game.submitHumanAction(action.actionId);
    if (!submitted.ok) {
      terminal.writeLine(submitted.message);
      continue;
    }
    terminal.writeLine(`You played ${formatMove(submitted.move)}.`);
  }
}

export async function runWithOwnedPlayEvaluator<T>(
  evaluator: OwnedNodeUciLeafEvaluator,
  operation: () => Promise<T>,
): Promise<T> {
  const outcome: OperationOutcome<T> = await Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        error: errorFromUnknown(error),
      }),
    );
  let cleanupFailure: Error | undefined;
  try {
    await evaluator.close();
  } catch (error: unknown) {
    cleanupFailure = errorFromUnknown(error);
  }
  if (cleanupFailure === undefined) {
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }
  const preserved = outcome.ok
    ? cleanupFailure
    : new AggregateError(
        [outcome.error, cleanupFailure],
        "Local play and evaluator cleanup both failed.",
      );
  if (playEvaluatorCleanupProvesComplete(cleanupFailure)) {
    throw preserved;
  }
  return throwAfterSameOwnerCleanup(
    preserved,
    () => evaluator.close(),
    "Local play evaluator cleanup remains incomplete.",
    playEvaluatorCleanupProvesComplete,
  );
}

function parsePlayOptions(arguments_: readonly string[]): ParsedPlayOptions {
  const args = arguments_.filter((argument) => argument !== "--");
  if (args.length === 1 && args[0] === "--help") {
    return {
      help: true,
      seed: DEFAULT_SEED,
      humanColor: "white",
      maxDepth: DEFAULT_MAX_DEPTH,
      maxNodes: DEFAULT_MAX_NODES,
    };
  }
  const values = new Map<string, string>();
  const allowed = new Set([
    "--evaluator-config",
    "--human-color",
    "--human-drawback",
    "--seed",
    "--max-depth",
    "--max-nodes",
    "--initial-fen",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || !allowed.has(name)) {
      throw new RangeError(`Unknown local play option: ${name ?? "<missing>"}.`);
    }
    if (values.has(name)) {
      throw new RangeError(`Local play option ${name} was provided twice.`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new RangeError(`Local play option ${name} requires a value.`);
    }
    values.set(name, value);
  }
  const evaluatorConfig = values.get("--evaluator-config");
  if (evaluatorConfig === undefined) {
    throw new RangeError("--evaluator-config is required for local play.");
  }
  const humanColor = values.get("--human-color") ?? "white";
  if (humanColor !== "white" && humanColor !== "black") {
    throw new RangeError("--human-color must be white or black.");
  }
  const drawbackInput = values.get("--human-drawback") ?? "random";
  const humanDrawbackId = drawbackInput === "random"
    ? undefined
    : parsePlayerPrivateRuleId(drawbackInput);
  const initialFen = values.get("--initial-fen");
  return {
    help: false,
    evaluatorConfig,
    seed: unsignedSeed(values.get("--seed"), DEFAULT_SEED),
    humanColor,
    ...(humanDrawbackId === undefined ? {} : { humanDrawbackId }),
    maxDepth: positiveInteger(
      values.get("--max-depth"),
      DEFAULT_MAX_DEPTH,
      "--max-depth",
    ),
    maxNodes: positiveInteger(
      values.get("--max-nodes"),
      DEFAULT_MAX_NODES,
      "--max-nodes",
    ),
    ...(initialFen === undefined ? {} : { initialFen }),
  };
}

function parsePlayerPrivateRuleId(value: string): PlayerPrivateRuleId {
  const matched = PLAYER_PRIVATE_RULE_IDS.find((id) => id === value);
  if (matched === undefined) {
    throw new RangeError(
      `--human-drawback must be random or one of: ${PLAYER_PRIVATE_RULE_IDS.join(", ")}.`,
    );
  }
  return matched;
}

function unsignedSeed(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 0
    || parsed > MAX_UNSIGNED_32_BIT_INTEGER
  ) {
    throw new RangeError("--seed must be an unsigned 32-bit integer.");
  }
  return parsed;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function parseCoordinateMove(input: string): ParsedCoordinateMove | null {
  const matched = /^([a-h][1-8])\s*(?:-|to)?\s*([a-h][1-8])(?:\s*=\s*([qrbn]))?$/iu
    .exec(input.trim());
  if (matched === null) {
    return null;
  }
  const from = matched[1]?.toLowerCase();
  const to = matched[2]?.toLowerCase();
  if (from === undefined || to === undefined) {
    return null;
  }
  const promotionSymbol = matched[3]?.toLowerCase();
  const promotion = promotionSymbol === undefined
    ? undefined
    : promotionFromSymbol(promotionSymbol);
  return {
    from,
    to,
    ...(promotion === undefined ? {} : { promotion }),
  };
}

function promotionFromSymbol(
  symbol: string,
): ParsedCoordinateMove["promotion"] {
  switch (symbol) {
    case "n":
      return "knight";
    case "b":
      return "bishop";
    case "r":
      return "rook";
    case "q":
      return "queen";
    default:
      throw new RangeError("Promotion must be Q, R, B, or N.");
  }
}

function sameVisibleMove(
  action: Pick<PlayerPlayAction, "from" | "to" | "promotion">,
  move: ParsedCoordinateMove,
): boolean {
  return (
    action.from === move.from
    && action.to === move.to
    && action.promotion === move.promotion
  );
}

function createNodeTerminal(
  input: Readable,
  output: Writable,
): PlayerPrivatePlayTerminal {
  const readline = createInterface({ input, output, terminal: false });
  return {
    writeLine(line = ""): void {
      output.write(`${line}\n`);
    },
    question(prompt: string, signal: AbortSignal): Promise<string> {
      return readline.question(prompt, { signal });
    },
    close(): void {
      readline.close();
    },
  };
}

function renderBoard(
  terminal: PlayerPrivatePlayTerminal,
  observation: PlayerPlayObservationV1,
): void {
  const pieces = new Map(
    observation.board.map((square) => [square.square, square.occupant] as const),
  );
  const files = observation.viewer === "white"
    ? ["a", "b", "c", "d", "e", "f", "g", "h"]
    : ["h", "g", "f", "e", "d", "c", "b", "a"];
  const ranks = observation.viewer === "white"
    ? [8, 7, 6, 5, 4, 3, 2, 1]
    : [1, 2, 3, 4, 5, 6, 7, 8];
  terminal.writeLine();
  for (const rank of ranks) {
    const row = files.map((file) =>
      pieceSymbol(pieces.get(`${file}${String(rank)}`) ?? null)
    );
    terminal.writeLine(`${String(rank)}  ${row.join(" ")}`);
  }
  terminal.writeLine(`   ${files.join(" ")}`);
  if (observation.lastMove !== null) {
    terminal.writeLine(`Last move: ${formatMove(observation.lastMove)}`);
  }
  terminal.writeLine();
}

function pieceSymbol(
  piece: PlayerPlayObservationV1["board"][number]["occupant"],
): string {
  if (piece === null) {
    return ".";
  }
  const symbols: Readonly<Record<typeof piece.type, string>> = {
    pawn: "p",
    knight: "n",
    bishop: "b",
    rook: "r",
    queen: "q",
    king: "k",
  };
  const symbol = symbols[piece.type];
  return piece.color === "white" ? symbol.toUpperCase() : symbol;
}

function renderMoves(
  terminal: PlayerPrivatePlayTerminal,
  actions: readonly PlayerPlayAction[],
): void {
  terminal.writeLine(
    actions.length === 0
      ? "No actions are available."
      : `Available actions: ${actions.map(formatMove).join(", ")}`,
  );
}

function renderOwnDrawback(
  terminal: PlayerPrivatePlayTerminal,
  observation: PlayerPlayObservationV1,
): void {
  const drawback = observation.ownDrawback;
  terminal.writeLine(
    `Your drawback: ${drawback.name} [${drawback.verification}]`,
  );
  terminal.writeLine(drawback.description);
  for (const instruction of drawback.turnInstructions) {
    terminal.writeLine(instruction);
  }
}

function renderEngineMove(
  terminal: PlayerPrivatePlayTerminal,
  result: PlayerPrivateEngineMove,
): void {
  terminal.writeLine(
    `Engine played ${formatMove(result.move)}; evaluator ${result.evaluatorId}.`,
  );
}

function renderStatus(
  terminal: PlayerPrivatePlayTerminal,
  observation: PlayerPlayObservationV1,
): void {
  const status = observation.status;
  if (status.kind === "active") {
    return;
  }
  if (status.kind === "draw") {
    terminal.writeLine(`Game drawn: ${status.reason}.`);
    return;
  }
  terminal.writeLine(
    `${capitalize(status.winner)} wins by ${status.reason.replaceAll("-", " ")}.`,
  );
}

function renderReveal(
  terminal: PlayerPrivatePlayTerminal,
  reveal: PlayerPrivatePlayReveal,
): void {
  terminal.writeLine("Post-game reveal:");
  terminal.writeLine(`White: ${formatReveal(reveal.white)}`);
  terminal.writeLine(`Black: ${formatReveal(reveal.black)}`);
}

function formatReveal(
  drawback: PlayerPrivatePlayReveal["white"],
): string {
  const details = drawback.details.length === 0
    ? ""
    : ` (${drawback.details.join(" ")})`;
  return `${drawback.name} [${drawback.verification}]${details}`;
}

function formatMove(
  move: Pick<PlayerVisibleMove, "from" | "to" | "promotion">,
): string {
  const promotion = move.promotion === undefined
    ? ""
    : `=${promotionSymbol(move.promotion)}`;
  return `${move.from}-${move.to}${promotion}`;
}

function promotionSymbol(
  promotion: NonNullable<PlayerVisibleMove["promotion"]>,
): string {
  switch (promotion) {
    case "knight":
      return "N";
    case "bishop":
      return "B";
    case "rook":
      return "R";
    case "queen":
      return "Q";
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function playEvaluatorCleanupProvesComplete(error: unknown): boolean {
  return error instanceof NodeUciLeafEvaluatorCloseError
    && error.privateResourcesRemoved
    && error.processTerminated;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Local play failed with a non-Error value.", { cause: error });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("Local play was aborted.", "AbortError");
}

function missingEvaluatorConfig(): never {
  throw new Error("The evaluator configuration path disappeared after validation.");
}
