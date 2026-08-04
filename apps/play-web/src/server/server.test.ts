import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import {
  inspectPublicGameTrace,
  publicAuthorityLegalMoves,
  publicGameTraceView,
} from "@drawbackengine/chess-core";
import {
  NodeUciLeafEvaluatorCloseError,
  type OwnedNodeUciLeafEvaluator,
} from "@drawbackengine/chess-evaluator";
import type {
  IterativePlayerPrivateSearchResult,
} from "@drawbackengine/drawback-search";
import {
  PlayerPrivatePlayGame,
  type PlayerPrivatePlaySearch,
  type PlayerPrivatePlaySearchRequest,
} from "@drawbackengine/simulation-arena";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PlayEvaluatorMetadata,
  PlayGameSnapshot,
} from "../shared/api.js";
import { startPlayWebServer, type StartedPlayWebServer } from "./server.js";

const openServers: StartedPlayWebServer[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(openServers.splice(0).map((server) => server.close()));
  await Promise.allSettled(tempRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("local browser play server", () => {
  it("routes a move through the real facade with the exact selected limits", async () => {
    const captured: PlayerPrivatePlaySearchRequest[] = [];
    const search: PlayerPrivatePlaySearch = (request) => {
      captured.push(request);
      return Promise.resolve(chooseFirstLegal(request, "e7", "e5"));
    };
    const fixture = await startFixture(search);
    const session = await browserSession(fixture.server);
    const created = await postJson<PlayGameSnapshot>(
      fixture.server,
      session,
      "/api/games",
      { humanColor: "white", humanDrawbackId: "vegan", strengthId: "balanced" },
    );
    const action = created.body.observation.actions.find(
      (candidate) => candidate.from === "e2" && candidate.to === "e4",
    );
    expect(action).toBeDefined();
    if (action === undefined) {
      throw new Error("Expected e2-e4.");
    }

    const resumedResponse = await request(
      fixture.server,
      session,
      `/api/games/${created.body.gameId}`,
    );
    expect(resumedResponse.status).toBe(200);
    const resumed = await resumedResponse.json() as PlayGameSnapshot;
    expect(resumed).toMatchObject({
      gameId: created.body.gameId,
      observation: { ply: 0, turn: "white" },
      strength: { id: "balanced", maxDepth: 2, maxNodes: 50_000 },
    });

    const moved = await postJson<PlayGameSnapshot>(
      fixture.server,
      session,
      `/api/games/${created.body.gameId}/actions`,
      { actionId: action.actionId, expectedPly: 0 },
    );

    expect(moved.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.limits).toMatchObject({
      maxDepth: 2,
      maxNodes: 50_000,
    });
    expect(captured[0]?.evaluator).toBe(fixture.evaluator);
    expect(moved.body.observation).toMatchObject({
      ply: 2,
      turn: "white",
      lastMove: { from: "e7", to: "e5" },
    });
    expect(moved.body.moves).toEqual([
      { ply: 1, color: "white", from: "e2", to: "e4" },
      { ply: 2, color: "black", from: "e7", to: "e5" },
    ]);
    expect(recursiveKeys(moved.body)).not.toEqual(
      expect.arrayContaining([
        "fen",
        "san",
        "captured",
        "score",
        "hypotheses",
        "opponentHypothesisCount",
        "completedDepth",
        "requestedDepth",
        "nodes",
        "executablePath",
        "variantPath",
      ]),
    );
  });

  it("rejects stale actions and keeps both drawbacks hidden until the end", async () => {
    const fixture = await startFixture((request) =>
      Promise.resolve(chooseFirstLegal(request, "e7", "e5")));
    const session = await browserSession(fixture.server);
    const created = await postJson<PlayGameSnapshot>(
      fixture.server,
      session,
      "/api/games",
      { humanColor: "white", humanDrawbackId: "vegan", strengthId: "quick" },
    );
    expect(created.body.reveal).toBeNull();
    const earlyReveal = await request(
      fixture.server,
      session,
      `/api/games/${created.body.gameId}/reveal`,
    );
    expect(earlyReveal.status).toBe(409);
    const action = created.body.observation.actions.find(
      (candidate) => candidate.from === "e2" && candidate.to === "e4",
    );
    if (action === undefined) {
      throw new Error("Expected e2-e4.");
    }
    await postJson(
      fixture.server,
      session,
      `/api/games/${created.body.gameId}/actions`,
      { actionId: action.actionId, expectedPly: 0 },
    );
    const stale = await postJson(
      fixture.server,
      session,
      `/api/games/${created.body.gameId}/actions`,
      { actionId: action.actionId, expectedPly: 0 },
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: "stale-action" } });

    const resigned = await postJson<PlayGameSnapshot>(
      fixture.server,
      session,
      `/api/games/${created.body.gameId}/resign`,
      undefined,
    );
    expect(resigned.body.observation.status).toMatchObject({
      kind: "win",
      winner: "black",
      reason: "resignation",
    });
    expect(resigned.body.reveal?.white.id).toBe("vegan");
    expect(resigned.body.reveal?.black.id).toEqual(expect.any(String));
  });

  it("binds to IPv4 loopback and rejects missing origins and rebinding hosts", async () => {
    const fixture = await startFixture((request) =>
      Promise.resolve(chooseFirstLegal(request)));
    expect(fixture.server.host).toBe("127.0.0.1");
    expect(fixture.server.url).toBe(`http://127.0.0.1:${String(fixture.server.port)}`);
    const session = await browserSession(fixture.server);
    const missingOrigin = await fetch(`${fixture.server.url}/api/games`, {
      method: "POST",
      headers: {
        Cookie: session.cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        humanColor: "white",
        humanDrawbackId: "vegan",
        strengthId: "quick",
      }),
    });
    expect(missingOrigin.status).toBe(403);
    expect(await rawHostStatus(fixture.server, "attacker.invalid")).toBe(421);
  });

  it("serializes searches from independent browser owners", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const search: PlayerPrivatePlaySearch = (request) =>
      new Promise((resolvePromise) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        releases.push(() => {
          active -= 1;
          resolvePromise(chooseFirstLegal(request));
        });
      });
    const fixture = await startFixture(search);
    const first = await browserSession(fixture.server);
    const second = await browserSession(fixture.server);
    const one = postJson(
      fixture.server,
      first,
      "/api/games",
      { humanColor: "black", humanDrawbackId: "vegan", strengthId: "quick" },
    );
    const two = postJson(
      fixture.server,
      second,
      "/api/games",
      { humanColor: "black", humanDrawbackId: "vegan", strengthId: "quick" },
    );
    await vi.waitFor(() => { expect(releases).toHaveLength(1); });
    expect(maximumActive).toBe(1);
    releases[0]?.();
    await vi.waitFor(() => { expect(releases).toHaveLength(2); });
    expect(maximumActive).toBe(1);
    releases[1]?.();
    await Promise.all([one, two]);
    expect(maximumActive).toBe(1);
  });

  it("aborts and awaits a replaced game before admitting its replacement", async () => {
    const pendingSearch: {
      reject: ((reason: Error) => void) | null;
    } = { reject: null };
    let aborted = false;
    const search: PlayerPrivatePlaySearch = ({ limits }) =>
      new Promise((_resolve, reject) => {
        pendingSearch.reject = reject;
        limits.signal?.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
      });
    const fixture = await startFixture(search);
    const session = await browserSession(fixture.server);
    const created = await postJson<PlayGameSnapshot>(
      fixture.server,
      session,
      "/api/games",
      { humanColor: "white", humanDrawbackId: "vegan", strengthId: "quick" },
    );
    const action = created.body.observation.actions.find(
      (candidate) => candidate.from === "e2" && candidate.to === "e4",
    );
    if (action === undefined) {
      throw new Error("Expected e2-e4.");
    }
    const pendingMove = postJson(
      fixture.server,
      session,
      `/api/games/${created.body.gameId}/actions`,
      { actionId: action.actionId, expectedPly: 0 },
    );
    await vi.waitFor(() => { expect(pendingSearch.reject).not.toBeNull(); });
    let replacementSettled = false;
    const replacement = postJson<PlayGameSnapshot>(
      fixture.server,
      session,
      "/api/games",
      { humanColor: "white", humanDrawbackId: "checkers", strengthId: "quick" },
    ).finally(() => {
      replacementSettled = true;
    });
    await vi.waitFor(() => { expect(aborted).toBe(true); });
    await Promise.resolve();
    expect(replacementSettled).toBe(false);
    const rejectPending = pendingSearch.reject;
    if (rejectPending === null) {
      throw new Error("Expected a pending search rejector.");
    }
    rejectPending(new DOMException("replaced", "AbortError"));
    const next = await replacement;
    expect(next.status).toBe(201);
    expect(next.body.observation.ownDrawback.id).toBe("checkers");
    await pendingMove;
  });

  it("aborts active work and closes the owned evaluator exactly once", async () => {
    let searchStarted = false;
    let observedAbort = false;
    const search: PlayerPrivatePlaySearch = ({ limits }) =>
      new Promise((_resolve, reject) => {
        searchStarted = true;
        limits.signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new DOMException("closed", "AbortError"));
        }, { once: true });
      });
    const fixture = await startFixture(search);
    const session = await browserSession(fixture.server);
    const pending = postJson(
      fixture.server,
      session,
      "/api/games",
      { humanColor: "black", humanDrawbackId: "vegan", strengthId: "quick" },
    );
    await vi.waitFor(() => { expect(searchStarted).toBe(true); });
    await fixture.server.close();
    expect((await pending).status).toBe(500);
    expect(observedAbort).toBe(true);
    expect(fixture.closeEvaluator).toHaveBeenCalledOnce();
    await fixture.server.close();
    expect(fixture.closeEvaluator).toHaveBeenCalledOnce();
  });

  it("retries incomplete evaluator cleanup through the same owner only", async () => {
    let attempts = 0;
    const fixture = await startFixture(
      (request) => Promise.resolve(chooseFirstLegal(request)),
      () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new NodeUciLeafEvaluatorCloseError(
              "incomplete",
              false,
              false,
            ))
          : Promise.resolve();
      },
    );
    await expect(fixture.server.close()).rejects.toThrow("incomplete");
    expect(fixture.closeEvaluator).toHaveBeenCalledTimes(2);
    await expect(fixture.server.close()).rejects.toThrow("incomplete");
    expect(fixture.closeEvaluator).toHaveBeenCalledTimes(2);
  });

  it("does not retry an evaluator failure that proves cleanup completed", async () => {
    const fixture = await startFixture(
      (request) => Promise.resolve(chooseFirstLegal(request)),
      () => Promise.reject(new NodeUciLeafEvaluatorCloseError(
        "closed with a reported error",
        true,
        true,
      )),
    );
    await expect(fixture.server.close()).rejects.toThrow("closed with a reported error");
    expect(fixture.closeEvaluator).toHaveBeenCalledOnce();
  });
});

async function startFixture(
  search: PlayerPrivatePlaySearch,
  closeImplementation: () => Promise<void> = () => Promise.resolve(),
): Promise<{
  readonly server: StartedPlayWebServer;
  readonly evaluator: OwnedNodeUciLeafEvaluator;
  readonly closeEvaluator: ReturnType<typeof vi.fn>;
}> {
  const staticRoot = await mkdtemp(join(tmpdir(), "drawback-play-web-"));
  tempRoots.push(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>play</title>");
  const closeEvaluator = vi.fn(closeImplementation);
  const evaluator: OwnedNodeUciLeafEvaluator = {
    id: "test-fairy-evaluator",
    evaluate: () => Promise.reject(new Error("The test search should not call the evaluator.")),
    close: closeEvaluator,
  };
  let token = 0;
  const server = await startPlayWebServer({
    port: 0,
    staticRoot,
    evaluator,
    evaluatorMetadata: evaluatorMetadata(),
    application: {
      createGame: (options) => PlayerPrivatePlayGame.create(options, { search }),
      generateSeed: () => 91,
      generateToken: (prefix) => {
        token += 1;
        return `${prefix.charAt(0)}${String(token)}`.padEnd(32, prefix.charAt(0));
      },
    },
  });
  openServers.push(server);
  return { server, evaluator, closeEvaluator };
}

async function browserSession(server: StartedPlayWebServer): Promise<{
  readonly cookie: string;
  readonly origin: string;
}> {
  const response = await fetch(`${server.url}/api/bootstrap`);
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) {
    throw new Error("Expected an owner cookie.");
  }
  return { cookie, origin: server.url };
}

async function postJson<T = unknown>(
  server: StartedPlayWebServer,
  session: { readonly cookie: string; readonly origin: string },
  path: string,
  body: unknown,
  parse: (value: unknown) => T = (value) => value as T,
): Promise<{ readonly status: number; readonly body: T }> {
  const response = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: {
      Cookie: session.cookie,
      Origin: session.origin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: parse(await response.json() as unknown) };
}

async function request(
  server: StartedPlayWebServer,
  session: { readonly cookie: string },
  path: string,
): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    headers: { Cookie: session.cookie },
  });
}

function chooseFirstLegal(
  request: PlayerPrivatePlaySearchRequest,
  preferredFrom?: string,
  preferredTo?: string,
): IterativePlayerPrivateSearchResult {
  const position = publicGameTraceView(request.context.trace);
  const authority = publicAuthorityLegalMoves(
    inspectPublicGameTrace(request.context.trace).current,
  );
  const legal = request.context.own.legalMoves(position, authority);
  const move = legal.find((candidate) =>
    candidate.from === preferredFrom && candidate.to === preferredTo) ?? legal[0];
  if (move === undefined) {
    throw new Error("Expected an exact legal engine move.");
  }
  return Object.freeze({
    move,
    score: 0,
    principalVariation: Object.freeze([move]),
    nodes: 1,
    leaves: 0,
    truncated: false,
    rootColor: position.turn,
    evaluatorId: request.evaluator.id,
    knowledgeMode: "player-private",
    aggregation: request.context.aggregation,
    opponentHypothesisCount: request.context.opponent.length,
    requestedDepth: request.limits.maxDepth,
    completedDepth: request.limits.maxDepth,
    stopReason: "target-depth",
    rootMoves: Object.freeze([{ move, score: 0, principalVariation: Object.freeze([move]) }]),
    leafCache: Object.freeze({
      hits: 0,
      misses: 0,
      evictions: 0,
      entries: 0,
      maxEntries: 1,
      historyMode: "full",
    }),
  });
}

function evaluatorMetadata(): PlayEvaluatorMetadata {
  return Object.freeze({
    kind: "Fairy-Stockfish",
    name: "Fairy-Stockfish test",
    version: "test",
    leafDepth: 4,
    hashMb: 32,
    threads: 1,
    multiPv: 1,
    limitStrength: false,
    skillLevel: 20,
    nnue: "disabled",
  });
}

function recursiveKeys(value: unknown): readonly string[] {
  const keys: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) {
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      keys.push(key);
      visit(nested);
    }
  };
  visit(value);
  return keys;
}

function rawHostStatus(
  server: StartedPlayWebServer,
  host: string,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      hostname: server.host,
      port: server.port,
      path: "/",
      method: "GET",
      headers: { Host: `${host}:${String(server.port)}` },
    }, (response) => {
      response.resume();
      response.once("end", () => { resolvePromise(response.statusCode ?? 0); });
    });
    request.once("error", reject);
    request.end();
  });
}
