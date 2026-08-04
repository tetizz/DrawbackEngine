import { useEffect, useRef, useState } from "react";
import type {
  CreatePlayGameRequest,
  PlayBootstrapResponse,
  PlayGameSnapshot,
} from "../shared/api.js";
import {
  createGame,
  loadBootstrap,
  loadGame,
  PlayApiClientError,
  resignGame,
  retryEngine,
  submitAction,
} from "./api-client.js";
import { GameScreen } from "./GameScreen.js";
import type { PendingHumanMove } from "./GameScreen.js";
import { SetupScreen } from "./SetupScreen.js";

const STORED_GAME_ID = "drawbackengine.localGameId";

export function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<PlayBootstrapResponse | null>(null);
  const [game, setGame] = useState<PlayGameSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingHumanMove, setPendingHumanMove] =
    useState<PendingHumanMove | null>(null);
  const currentOperation = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    currentOperation.current = controller;
    void (async () => {
      try {
        const loaded = await loadBootstrap(controller.signal);
        setBootstrap(loaded);
        const stored = readStoredGame();
        if (stored !== null) {
          try {
            const resumed = await loadGame(stored, controller.signal);
            setGame(resumed);
          } catch (resumeError: unknown) {
            if (!(resumeError instanceof PlayApiClientError && resumeError.status === 404)) {
              throw resumeError;
            }
            clearStoredGame();
          }
        }
      } catch (startupError: unknown) {
        if (!controller.signal.aborted) {
          setError(messageFromError(startupError));
        }
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
        }
      }
    })();
    return () => { controller.abort(); };
  }, []);

  const run = async (
    operation: (signal: AbortSignal) => Promise<PlayGameSnapshot>,
  ): Promise<void> => {
    currentOperation.current?.abort();
    const controller = new AbortController();
    currentOperation.current = controller;
    setBusy(true);
    setError(null);
    try {
      const next = await operation(controller.signal);
      setGame(next);
      writeStoredGame(next.gameId);
    } catch (operationError: unknown) {
      if (!controller.signal.aborted) {
        setError(messageFromError(operationError));
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  };

  const submit = (actionId: string): void => {
    if (game === null) {
      return;
    }
    const gameId = game.gameId;
    const expectedPly = game.observation.ply;
    const action = game.observation.actions.find(
      (candidate) => candidate.actionId === actionId,
    );
    if (action === undefined) {
      return;
    }
    setPendingHumanMove({ action, fromPly: expectedPly });
    void (async () => {
      try {
        await run(async (signal) => {
          try {
            return await submitAction(gameId, { actionId, expectedPly }, signal);
          } catch (operationError: unknown) {
            if (operationError instanceof PlayApiClientError) {
              try {
                const current = await loadGame(gameId, signal);
                setGame(current);
              } catch {
                // Preserve the originating mutation error. A failed recovery
                // read must not replace a useful engine failure with a 404 or
                // network error.
              }
            }
            throw operationError;
          }
        });
      } finally {
        setPendingHumanMove((current) =>
          current?.action.actionId === actionId && current.fromPly === expectedPly
            ? null
            : current
        );
      }
    })();
  };

  if (bootstrap === null) {
    return (
      <main className="loading-shell" aria-live="polite">
        <span className="brand-mark" aria-hidden="true">D</span>
        <span className="spinner large" aria-hidden="true" />
        <h1>Starting local play</h1>
        <p>{error ?? "Authenticating the configured evaluator…"}</p>
        {error === null ? null : (
          <button className="secondary-button" onClick={() => { window.location.reload(); }} type="button">
            Try again
          </button>
        )}
      </main>
    );
  }

  if (game === null) {
    return (
      <SetupScreen
        bootstrap={bootstrap}
        busy={busy}
        error={error}
        onStart={(request: CreatePlayGameRequest) => {
          void run((signal) => createGame(request, signal));
        }}
      />
    );
  }

  return (
    <GameScreen
      busy={busy}
      error={error}
      game={game}
      pendingHumanMove={pendingHumanMove}
      onAction={submit}
      onNewGame={() => {
        currentOperation.current?.abort();
        clearStoredGame();
        setPendingHumanMove(null);
        setGame(null);
        setBusy(false);
        setError(null);
      }}
      onResign={() => void run((signal) => resignGame(game.gameId, signal))}
      onRetryEngine={() => void run((signal) => retryEngine(game.gameId, signal))}
    />
  );
}

function messageFromError(error: unknown): string {
  if (error instanceof PlayApiClientError || error instanceof Error) {
    return error.message;
  }
  return "The local engine could not complete that request.";
}

function readStoredGame(): string | null {
  try {
    return window.sessionStorage.getItem(STORED_GAME_ID);
  } catch {
    return null;
  }
}

function writeStoredGame(gameId: string): void {
  try {
    window.sessionStorage.setItem(STORED_GAME_ID, gameId);
  } catch {
    // The game still works when browser storage is unavailable.
  }
}

function clearStoredGame(): void {
  try {
    window.sessionStorage.removeItem(STORED_GAME_ID);
  } catch {
    // Nothing else is required when browser storage is unavailable.
  }
}
