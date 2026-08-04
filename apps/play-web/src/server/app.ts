import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DrawbackLeafEvaluator } from "@drawbackengine/drawback-search";
import {
  PLAYER_PRIVATE_RULE_IDS,
  PlayerPrivatePlayGame,
  resolvePlayerPrivateRule,
  type PlayerActionSubmission,
  type PlayerPlayObservationV1,
  type PlayerPrivateEngineMove,
  type PlayerPrivatePlayOptions,
  type PlayerPrivatePlayReveal,
  type PlayerPrivateRuleId,
} from "@drawbackengine/simulation-arena";
import type { PlayerColor } from "@drawbackengine/shared";
import {
  PLAY_STRENGTHS,
  PLAY_WEB_API_VERSION,
  resolvePlayStrength,
  type CreatePlayGameRequest,
  type PlayApiError,
  type PlayBootstrapResponse,
  type PlayDrawbackChoice,
  type PlayEvaluatorMetadata,
  type PlayGameSnapshot,
  type PlayMoveRecord,
  type PlayStrength,
  type SubmitPlayActionRequest,
} from "../shared/api.js";

const MAX_REQUEST_BYTES = 16 * 1024;
const OWNER_COOKIE = "drawback_play_owner";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const ACTION_ID_PATTERN = /^action_[A-Za-z0-9_-]{16,128}$/u;
const GAME_ID_PATTERN = /^game_[A-Za-z0-9_-]{24,128}$/u;

export interface PlayWebGame {
  readonly humanColor: PlayerColor;
  observation(): PlayerPlayObservationV1;
  submitHumanAction(actionId: string): PlayerActionSubmission;
  playEngineTurn(
    evaluator: DrawbackLeafEvaluator,
    limits: {
      readonly maxDepth: number;
      readonly maxNodes: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<PlayerPrivateEngineMove>;
  resignHuman(): PlayerPlayObservationV1;
  reveal(): PlayerPrivatePlayReveal;
}

export interface PlayWebApplicationOptions {
  readonly evaluator: DrawbackLeafEvaluator;
  readonly evaluatorMetadata: PlayEvaluatorMetadata;
  readonly expectedPort: () => number;
  readonly createGame?: (options: PlayerPrivatePlayOptions) => PlayWebGame;
  readonly generateSeed?: () => number;
  readonly generateToken?: (prefix: "game" | "owner") => string;
  readonly reportInternalError?: (error: unknown) => void;
}

interface GameRecord {
  readonly id: string;
  readonly owner: string;
  readonly game: PlayWebGame;
  readonly strength: PlayStrength;
  readonly moves: PlayMoveRecord[];
  thinking: boolean;
  activeSearch: AbortController | null;
  pendingSearch: Promise<void> | null;
}

export interface PlayWebApplication {
  handleApi(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export class PlayWebHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlayWebHttpError";
  }
}

export function createPlayWebApplication(
  options: PlayWebApplicationOptions,
): PlayWebApplication {
  const createGame = options.createGame ?? ((gameOptions) =>
    PlayerPrivatePlayGame.create(gameOptions));
  const generateSeed = options.generateSeed ?? randomSeed;
  const generateToken = options.generateToken ?? randomToken;
  const games = new Map<string, GameRecord>();
  const gameByOwner = new Map<string, string>();
  let evaluatorQueue: Promise<void> = Promise.resolve();
  let closing = false;

  const handleApi = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const path = requestUrl(request).pathname;
    if (!path.startsWith("/api/")) {
      return false;
    }
    applyApiHeaders(response);
    try {
      if (closing) {
        throw new PlayWebHttpError(503, "server-closing", "The local server is closing.");
      }
      assertLoopbackRequest(request, options.expectedPort());
      const method = request.method ?? "GET";
      if (method !== "GET") {
        validateMutationOrigin(request, options.expectedPort());
      }
      if (method === "GET" && path === "/api/bootstrap") {
        const owner = ownerFromRequest(request) ?? generateToken("owner");
        setOwnerCookie(response, owner);
        sendJson(response, 200, bootstrapResponse(options.evaluatorMetadata));
        return true;
      }
      const owner = requireOwner(request);
      if (method === "POST" && path === "/api/games") {
        const body = parseCreateRequest(await readJsonBody(request));
        const strength = resolvePlayStrength(body.strengthId);
        if (strength === undefined) {
          throw new PlayWebHttpError(400, "invalid-strength", "Choose an available search preset.");
        }
        const ruleId = playerPrivateRuleId(body.humanDrawbackId);
        const previousId = gameByOwner.get(owner);
        if (previousId !== undefined) {
          const previous = games.get(previousId);
          previous?.activeSearch?.abort(
            new DOMException("A new local game replaced this game.", "AbortError"),
          );
          if (previous?.pendingSearch !== null && previous?.pendingSearch !== undefined) {
            await previous.pendingSearch.catch(() => undefined);
          }
          games.delete(previousId);
        }
        const id = `game_${generateToken("game")}`;
        const game = createGame({
          seed: generateSeed(),
          humanColor: body.humanColor,
          humanDrawbackId: ruleId,
        });
        const record: GameRecord = {
          id,
          owner,
          game,
          strength,
          moves: [],
          thinking: false,
          activeSearch: null,
          pendingSearch: null,
        };
        games.set(id, record);
        gameByOwner.set(owner, id);
        try {
          if (game.observation().turn !== game.humanColor) {
            await runEngineTurn(
              record,
              request,
              response,
              options.evaluator,
              queueEvaluator,
            );
          }
        } catch (error: unknown) {
          games.delete(id);
          gameByOwner.delete(owner);
          throw error;
        }
        sendJson(response, 201, snapshot(record, options.evaluatorMetadata));
        return true;
      }

      const route = gameRoute(path);
      if (route === null) {
        throw new PlayWebHttpError(404, "not-found", "The local API route does not exist.");
      }
      const record = requireOwnedGame(games, route.gameId, owner);
      if (method === "GET" && route.action === "snapshot") {
        sendJson(response, 200, snapshot(record, options.evaluatorMetadata));
        return true;
      }
      if (method === "POST" && route.action === "actions") {
        const body = parseActionRequest(await readJsonBody(request));
        const before = record.game.observation();
        if (body.expectedPly !== before.ply) {
          throw new PlayWebHttpError(409, "stale-action", "The board changed before that move arrived.");
        }
        const color = before.turn;
        const submitted = record.game.submitHumanAction(body.actionId);
        if (!submitted.ok) {
          throw new PlayWebHttpError(409, "stale-action", submitted.message);
        }
        record.moves.push(moveRecord(record.moves.length + 1, color, submitted.move));
        if (
          submitted.observation.status.kind === "active"
          && submitted.observation.turn !== record.game.humanColor
        ) {
          await runEngineTurn(
            record,
            request,
            response,
            options.evaluator,
            queueEvaluator,
          );
        }
        sendJson(response, 200, snapshot(record, options.evaluatorMetadata));
        return true;
      }
      if (method === "POST" && route.action === "engine") {
        const observation = record.game.observation();
        if (
          observation.status.kind !== "active"
          || observation.turn === record.game.humanColor
        ) {
          throw new PlayWebHttpError(409, "engine-turn-unavailable", "The engine has no move to play.");
        }
        await runEngineTurn(
          record,
          request,
          response,
          options.evaluator,
          queueEvaluator,
        );
        sendJson(response, 200, snapshot(record, options.evaluatorMetadata));
        return true;
      }
      if (method === "POST" && route.action === "resign") {
        record.activeSearch?.abort(
          new DOMException("The human player resigned.", "AbortError"),
        );
        if (record.game.observation().status.kind === "active") {
          record.game.resignHuman();
        }
        sendJson(response, 200, snapshot(record, options.evaluatorMetadata));
        return true;
      }
      if (method === "GET" && route.action === "reveal") {
        if (record.game.observation().status.kind === "active") {
          throw new PlayWebHttpError(409, "reveal-unavailable", "Drawbacks stay hidden until the game ends.");
        }
        sendJson(response, 200, record.game.reveal());
        return true;
      }
      throw new PlayWebHttpError(405, "method-not-allowed", "That method is not available for this route.");
    } catch (error: unknown) {
      if (response.writableEnded || response.destroyed) {
        return true;
      }
      if (error instanceof PlayWebHttpError) {
        sendJson(response, error.status, apiError(error.code, error.message));
      } else {
        options.reportInternalError?.(error);
        sendJson(
          response,
          500,
          apiError("internal-error", "The local engine could not complete that request."),
        );
      }
      return true;
    }
  };

  function queueEvaluator(operation: () => Promise<void>): Promise<void> {
    const queued = evaluatorQueue.then(operation, operation);
    evaluatorQueue = queued.catch(() => undefined);
    return queued;
  }

  return Object.freeze({
    handleApi,
    async close(): Promise<void> {
      closing = true;
      const pending: Promise<void>[] = [];
      for (const record of games.values()) {
        record.activeSearch?.abort(
          new DOMException("The local server is closing.", "AbortError"),
        );
        if (record.pendingSearch !== null) {
          pending.push(record.pendingSearch);
        }
      }
      await Promise.allSettled(pending);
      games.clear();
      gameByOwner.clear();
    },
  });
}

async function runEngineTurn(
  record: GameRecord,
  request: IncomingMessage,
  response: ServerResponse,
  evaluator: DrawbackLeafEvaluator,
  queueEvaluator: (operation: () => Promise<void>) => Promise<void>,
): Promise<void> {
  if (record.thinking) {
    throw new PlayWebHttpError(409, "engine-busy", "The engine is already thinking.");
  }
  const controller = new AbortController();
  const abortDisconnectedRequest = (): void => {
    if (!response.writableEnded) {
      controller.abort(
        new DOMException("The browser disconnected during search.", "AbortError"),
      );
    }
  };
  request.once("aborted", abortDisconnectedRequest);
  response.once("close", abortDisconnectedRequest);
  record.thinking = true;
  record.activeSearch = controller;
  const color = record.game.observation().turn;
  const operation = queueEvaluator(async () => {
    if (controller.signal.aborted) {
      throw abortReason(controller.signal);
    }
    const result = await record.game.playEngineTurn(evaluator, {
      maxDepth: record.strength.maxDepth,
      maxNodes: record.strength.maxNodes,
      signal: controller.signal,
    });
    record.moves.push(moveRecord(record.moves.length + 1, color, result.move));
  });
  record.pendingSearch = operation;
  try {
    await operation;
  } finally {
    request.off("aborted", abortDisconnectedRequest);
    response.off("close", abortDisconnectedRequest);
    if (record.activeSearch === controller) {
      record.activeSearch = null;
    }
    if (record.pendingSearch === operation) {
      record.pendingSearch = null;
    }
    record.thinking = false;
  }
}

function snapshot(
  record: GameRecord,
  evaluator: PlayEvaluatorMetadata,
): PlayGameSnapshot {
  const observation = record.game.observation();
  return Object.freeze({
    schema: PLAY_WEB_API_VERSION,
    gameId: record.id,
    observation,
    moves: Object.freeze(record.moves.map((move) => Object.freeze({ ...move }))),
    strength: record.strength,
    evaluator,
    thinking: record.thinking,
    reveal:
      observation.status.kind === "active"
        ? null
        : record.game.reveal(),
  });
}

function bootstrapResponse(
  evaluator: PlayEvaluatorMetadata,
): PlayBootstrapResponse {
  const drawbacks: PlayDrawbackChoice[] = PLAYER_PRIVATE_RULE_IDS.map((id) => {
    const rule = resolvePlayerPrivateRule(id);
    return Object.freeze({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      verification: rule.verification,
    });
  });
  return Object.freeze({
    schema: PLAY_WEB_API_VERSION,
    evaluator,
    strengths: PLAY_STRENGTHS,
    drawbacks: Object.freeze(drawbacks),
  });
}

function parseCreateRequest(value: unknown): CreatePlayGameRequest {
  const input = exactRecord(
    value,
    ["humanColor", "humanDrawbackId", "strengthId"],
    "new game request",
  );
  const humanColor = input["humanColor"];
  if (humanColor !== "white" && humanColor !== "black") {
    throw new PlayWebHttpError(400, "invalid-color", "Choose White or Black.");
  }
  return Object.freeze({
    humanColor,
    humanDrawbackId: singleLine(input["humanDrawbackId"], "human drawback"),
    strengthId: singleLine(input["strengthId"], "search preset") as CreatePlayGameRequest["strengthId"],
  });
}

function parseActionRequest(value: unknown): SubmitPlayActionRequest {
  const input = exactRecord(value, ["actionId", "expectedPly"], "move request");
  const actionId = singleLine(input["actionId"], "action capability");
  if (!ACTION_ID_PATTERN.test(actionId)) {
    throw new PlayWebHttpError(400, "invalid-action", "The move capability is invalid.");
  }
  const expectedPly = input["expectedPly"];
  if (!Number.isSafeInteger(expectedPly) || (expectedPly as number) < 0) {
    throw new PlayWebHttpError(400, "invalid-ply", "The move position is invalid.");
  }
  return Object.freeze({ actionId, expectedPly: expectedPly as number });
}

function playerPrivateRuleId(value: string): PlayerPrivateRuleId {
  const id = PLAYER_PRIVATE_RULE_IDS.find((candidate) => candidate === value);
  if (id === undefined) {
    throw new PlayWebHttpError(400, "invalid-drawback", "Choose an available audited drawback.");
  }
  return id;
}

function moveRecord(
  ply: number,
  color: PlayerColor,
  move: PlayerPrivateEngineMove["move"],
): PlayMoveRecord {
  return Object.freeze({
    ply,
    color,
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  });
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlayWebHttpError(400, "invalid-request", `The ${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    throw new PlayWebHttpError(400, "invalid-request", `The ${label} has invalid fields.`);
  }
  return record;
}

function singleLine(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 160
    || value.trim() !== value
    || /[\r\n\0]/u.test(value)
  ) {
    throw new PlayWebHttpError(400, "invalid-request", `The ${label} is invalid.`);
  }
  return value;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new PlayWebHttpError(415, "content-type", "Send requests as application/json.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new PlayWebHttpError(413, "request-too-large", "The request is too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new PlayWebHttpError(400, "invalid-json", "The request body is not valid JSON.");
  }
}

function gameRoute(path: string): {
  readonly gameId: string;
  readonly action: "snapshot" | "actions" | "engine" | "resign" | "reveal";
} | null {
  const matched = /^\/api\/games\/(game_[A-Za-z0-9_-]+)(?:\/(actions|engine|resign|reveal))?$/u.exec(path);
  if (matched === null || matched[1] === undefined || !GAME_ID_PATTERN.test(matched[1])) {
    return null;
  }
  const suffix = matched[2];
  const action = suffix === undefined ? "snapshot" : suffix;
  if (
    action !== "snapshot"
    && action !== "actions"
    && action !== "engine"
    && action !== "resign"
    && action !== "reveal"
  ) {
    return null;
  }
  return Object.freeze({ gameId: matched[1], action });
}

function requireOwnedGame(
  games: ReadonlyMap<string, GameRecord>,
  gameId: string,
  owner: string,
): GameRecord {
  const game = games.get(gameId);
  if (game === undefined || game.owner !== owner) {
    throw new PlayWebHttpError(404, "game-not-found", "That local game is unavailable.");
  }
  return game;
}

function requestUrl(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    throw new PlayWebHttpError(400, "invalid-url", "The request URL is invalid.");
  }
}

export function assertLoopbackRequest(
  request: IncomingMessage,
  port: number,
): void {
  const remote = request.socket.remoteAddress;
  if (
    remote !== "127.0.0.1"
    && remote !== "::1"
    && remote !== "::ffff:127.0.0.1"
  ) {
    throw new PlayWebHttpError(403, "loopback-only", "This server accepts local requests only.");
  }
  const host = request.headers.host;
  const allowed = new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]);
  if (host === undefined || !allowed.has(host.toLowerCase())) {
    throw new PlayWebHttpError(421, "invalid-host", "The local Host header is invalid.");
  }
}

function validateMutationOrigin(request: IncomingMessage, port: number): void {
  const host = request.headers.host?.toLowerCase();
  const origin = request.headers.origin;
  if (
    host === undefined
    || origin === undefined
    || origin !== `http://${host}`
    || (
      origin !== `http://127.0.0.1:${String(port)}`
      && origin !== `http://localhost:${String(port)}`
    )
  ) {
    throw new PlayWebHttpError(403, "invalid-origin", "The request did not come from this local app.");
  }
}

function ownerFromRequest(request: IncomingMessage): string | null {
  const cookie = request.headers.cookie;
  if (cookie === undefined) {
    return null;
  }
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === OWNER_COOKIE) {
      const value = rest.join("=");
      return TOKEN_PATTERN.test(value) ? value : null;
    }
  }
  return null;
}

function requireOwner(request: IncomingMessage): string {
  const owner = ownerFromRequest(request);
  if (owner === null) {
    throw new PlayWebHttpError(401, "missing-session", "Reload the local app to start a session.");
  }
  return owner;
}

function setOwnerCookie(response: ServerResponse, owner: string): void {
  response.setHeader(
    "Set-Cookie",
    `${OWNER_COOKIE}=${owner}; Path=/; HttpOnly; SameSite=Strict`,
  );
}

function applyApiHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function apiError(code: string, message: string): PlayApiError {
  return Object.freeze({ error: Object.freeze({ code, message }) });
}

function randomSeed(): number {
  return randomBytes(4).readUInt32LE(0);
}

function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The queued engine search was aborted.", "AbortError");
}
