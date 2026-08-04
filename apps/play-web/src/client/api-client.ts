import type {
  CreatePlayGameRequest,
  PlayApiError,
  PlayBootstrapResponse,
  PlayGameSnapshot,
  SubmitPlayActionRequest,
} from "../shared/api.js";

export class PlayApiClientError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlayApiClientError";
  }
}

export function loadBootstrap(signal?: AbortSignal): Promise<PlayBootstrapResponse> {
  return requestJson<PlayBootstrapResponse>(
    "/api/bootstrap",
    signal === undefined ? {} : { signal },
  );
}

export function createGame(
  request: CreatePlayGameRequest,
  signal?: AbortSignal,
): Promise<PlayGameSnapshot> {
  return requestJson<PlayGameSnapshot>("/api/games", {
    method: "POST",
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function loadGame(
  gameId: string,
  signal?: AbortSignal,
): Promise<PlayGameSnapshot> {
  return requestJson<PlayGameSnapshot>(
    gamePath(gameId),
    signal === undefined ? {} : { signal },
  );
}

export function submitAction(
  gameId: string,
  request: SubmitPlayActionRequest,
  signal?: AbortSignal,
): Promise<PlayGameSnapshot> {
  return requestJson<PlayGameSnapshot>(`${gamePath(gameId)}/actions`, {
    method: "POST",
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function retryEngine(
  gameId: string,
  signal?: AbortSignal,
): Promise<PlayGameSnapshot> {
  return requestJson<PlayGameSnapshot>(`${gamePath(gameId)}/engine`, {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
  });
}

export function resignGame(
  gameId: string,
  signal?: AbortSignal,
): Promise<PlayGameSnapshot> {
  return requestJson<PlayGameSnapshot>(`${gamePath(gameId)}/resign`, {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
  });
}

async function requestJson<T>(
  input: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
  });
  const parsed = await parseJson(response);
  if (!response.ok) {
    const error = parseApiError(parsed);
    throw new PlayApiClientError(response.status, error.code, error.message);
  }
  return parsed as T;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new PlayApiClientError(
      response.status,
      "invalid-response",
      "The local engine returned an unreadable response.",
    );
  }
}

function parseApiError(value: unknown): PlayApiError["error"] {
  if (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "error" in value
  ) {
    const error = (value as { readonly error?: unknown }).error;
    if (
      typeof error === "object"
      && error !== null
      && !Array.isArray(error)
      && "code" in error
      && "message" in error
    ) {
      const candidate = error as { readonly code?: unknown; readonly message?: unknown };
      if (typeof candidate.code === "string" && typeof candidate.message === "string") {
        return { code: candidate.code, message: candidate.message };
      }
    }
  }
  return {
    code: "request-failed",
    message: "The local engine could not complete that request.",
  };
}

function gamePath(gameId: string): string {
  return `/api/games/${encodeURIComponent(gameId)}`;
}
