import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, isAbsolute, resolve, sep } from "node:path";
import {
  NodeUciLeafEvaluatorCloseError,
  throwAfterSameOwnerCleanup,
  type OwnedNodeUciLeafEvaluator,
} from "@drawbackengine/chess-evaluator";
import type { PlayEvaluatorMetadata } from "../shared/api.js";
import {
  assertLoopbackRequest,
  createPlayWebApplication,
  PlayWebHttpError,
  type PlayWebApplicationOptions,
} from "./app.js";

export const PLAY_WEB_HOST = "127.0.0.1" as const;

export interface StartPlayWebServerOptions {
  readonly port: number;
  readonly staticRoot: string;
  readonly evaluator: OwnedNodeUciLeafEvaluator;
  readonly evaluatorMetadata: PlayEvaluatorMetadata;
  readonly application?: Omit<
    PlayWebApplicationOptions,
    "evaluator" | "evaluatorMetadata" | "expectedPort"
  >;
}

export interface StartedPlayWebServer {
  readonly host: typeof PLAY_WEB_HOST;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startPlayWebServer(
  options: StartPlayWebServerOptions,
): Promise<StartedPlayWebServer> {
  validatePort(options.port);
  if (!isAbsolute(options.staticRoot)) {
    throw new RangeError("The static client root must be absolute.");
  }
  let actualPort = options.port;
  const application = createPlayWebApplication({
    evaluator: options.evaluator,
    evaluatorMetadata: options.evaluatorMetadata,
    expectedPort: () => actualPort,
    ...options.application,
  });
  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      server,
      (incoming, outgoing) => application.handleApi(incoming, outgoing),
      options.staticRoot,
      () => actualPort,
    );
  });
  try {
    await listen(server, options.port);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The local play server did not expose a TCP address.");
    }
    actualPort = address.port;
  } catch (error: unknown) {
    return cleanupFailedStartup(
      error,
      server,
      () => application.close(),
      options.evaluator,
    );
  }

  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    host: PLAY_WEB_HOST,
    port: actualPort,
    url: `http://${PLAY_WEB_HOST}:${String(actualPort)}`,
    close(): Promise<void> {
      if (closePromise !== null) {
        return closePromise;
      }
      closePromise = closeAll(
        server,
        () => application.close(),
        options.evaluator,
      );
      return closePromise;
    },
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  server: Server,
  handleApi: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<boolean>,
  staticRoot: string,
  expectedPort: () => number,
): Promise<void> {
  try {
    if (await handleApi(request, response)) {
      return;
    }
    assertLoopbackRequest(request, expectedPort());
    await serveStatic(request, response, staticRoot);
  } catch (error: unknown) {
    if (response.writableEnded || response.destroyed) {
      return;
    }
    const status = error instanceof PlayWebHttpError ? error.status : 500;
    const message = status === 404 ? "Not found" : "Local server error";
    applyStaticSecurityHeaders(response);
    response.statusCode = status;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(message);
    if (status === 500) {
      server.emit("playWebInternalError", error);
    }
  }
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  staticRoot: string,
): Promise<void> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    throw new PlayWebHttpError(405, "method-not-allowed", "Static files are read-only.");
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new PlayWebHttpError(400, "invalid-url", "The request path is invalid.");
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const root = resolve(staticRoot);
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new PlayWebHttpError(404, "not-found", "Static file not found.");
  }
  let fileInfo;
  try {
    fileInfo = await stat(candidate);
  } catch {
    throw new PlayWebHttpError(404, "not-found", "Static file not found.");
  }
  if (!fileInfo.isFile()) {
    throw new PlayWebHttpError(404, "not-found", "Static file not found.");
  }
  const body = await readFile(candidate);
  applyStaticSecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("Content-Type", mimeType(candidate));
  response.setHeader("Content-Length", body.length);
  response.setHeader(
    "Cache-Control",
    relativePath === "index.html"
      ? "no-store"
      : "public, max-age=31536000, immutable",
  );
  if (method === "HEAD") {
    response.end();
  } else {
    response.end(body);
  }
}

function applyStaticSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("The local server port must be between 0 and 65535.");
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: PLAY_WEB_HOST, port });
  });
}

async function closeAll(
  server: Server,
  closeApplication: () => Promise<void>,
  evaluator: OwnedNodeUciLeafEvaluator,
): Promise<void> {
  const applicationResult = await settledFailure(closeApplication());
  const serverResult = await settledFailure(closeServer(server));
  const primaryFailures = [applicationResult, serverResult].filter(
    (failure): failure is Error => failure !== null,
  );
  let evaluatorFailure: Error | null = null;
  try {
    await evaluator.close();
  } catch (error: unknown) {
    evaluatorFailure = errorFromUnknown(error);
  }
  if (evaluatorFailure === null) {
    throwFailures(primaryFailures, "Local play server cleanup encountered failures.");
    return;
  }
  const original = aggregateFailures(
    [...primaryFailures, evaluatorFailure],
    "Local play server cleanup encountered failures.",
  );
  if (evaluatorCleanupProvesComplete(evaluatorFailure)) {
    throw original;
  }
  return throwAfterSameOwnerCleanup(
    original,
    () => evaluator.close(),
    "Local play evaluator cleanup remains incomplete.",
    evaluatorCleanupProvesComplete,
  );
}

async function cleanupFailedStartup(
  primaryFailure: unknown,
  server: Server,
  closeApplication: () => Promise<void>,
  evaluator: OwnedNodeUciLeafEvaluator,
): Promise<never> {
  const failures: Error[] = [errorFromUnknown(primaryFailure)];
  const applicationFailure = await settledFailure(closeApplication());
  if (applicationFailure !== null) {
    failures.push(applicationFailure);
  }
  if (server.listening) {
    const serverFailure = await settledFailure(closeServer(server));
    if (serverFailure !== null) {
      failures.push(serverFailure);
    }
  }
  let evaluatorFailure: Error | null = null;
  try {
    await evaluator.close();
  } catch (error: unknown) {
    evaluatorFailure = errorFromUnknown(error);
    failures.push(evaluatorFailure);
  }
  const original = aggregateFailures(
    failures,
    "Local play startup and cleanup encountered failures.",
  );
  if (evaluatorFailure === null || evaluatorCleanupProvesComplete(evaluatorFailure)) {
    throw original;
  }
  return throwAfterSameOwnerCleanup(
    original,
    () => evaluator.close(),
    "Local play startup evaluator cleanup remains incomplete.",
    evaluatorCleanupProvesComplete,
  );
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
    server.closeIdleConnections();
  });
}

async function settledFailure(operation: Promise<void>): Promise<Error | null> {
  try {
    await operation;
    return null;
  } catch (error: unknown) {
    return error instanceof Error
      ? error
      : new Error("Cleanup failed with a non-Error value.", { cause: error });
  }
}

function evaluatorCleanupProvesComplete(error: unknown): boolean {
  return error instanceof NodeUciLeafEvaluatorCloseError
    && error.privateResourcesRemoved
    && error.processTerminated;
}

function aggregateFailures(failures: readonly Error[], message: string): Error {
  if (failures.length === 0) {
    throw new Error("Expected at least one failure to aggregate.");
  }
  return failures.length === 1
    ? failures[0] as Error
    : new AggregateError(failures, message);
}

function throwFailures(failures: readonly Error[], message: string): void {
  if (failures.length > 0) {
    throw aggregateFailures(failures, message);
  }
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Operation failed with a non-Error value.", { cause: error });
}
