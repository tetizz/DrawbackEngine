// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlayerPrivatePlayGame } from "@drawbackengine/simulation-arena";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PlayBootstrapResponse,
  PlayGameSnapshot,
} from "../shared/api.js";
import { PLAY_STRENGTHS, PLAY_WEB_API_VERSION } from "../shared/api.js";
import {
  createGame,
  loadBootstrap,
  loadGame,
  PlayApiClientError,
  resignGame,
  retryEngine,
  submitAction,
} from "./api-client.js";
import { App } from "./App.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface MockGameScreenProps {
  readonly game: PlayGameSnapshot;
  readonly error: string | null;
  readonly onAction: (actionId: string) => void;
}

vi.mock("./api-client.js", () => ({
  createGame: vi.fn(),
  loadBootstrap: vi.fn(),
  loadGame: vi.fn(),
  resignGame: vi.fn(),
  retryEngine: vi.fn(),
  submitAction: vi.fn(),
  PlayApiClientError: class extends Error {
    public constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "PlayApiClientError";
    }
  },
}));

vi.mock("./GameScreen.js", () => ({
  GameScreen: ({ game, error, onAction }: MockGameScreenProps) => (
    <div>
      <span>{error}</span>
      <button
        onClick={() => { onAction(game.observation.actions[0]?.actionId ?? ""); }}
        type="button"
      >
        Submit move
      </button>
    </div>
  ),
}));

vi.mock("./SetupScreen.js", () => ({ SetupScreen: () => <div>Setup</div> }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
  }
  container?.remove();
  window.sessionStorage.clear();
  vi.resetAllMocks();
  root = null;
  container = null;
});

describe("App action recovery", () => {
  it("preserves the engine failure when the recovery snapshot also fails", async () => {
    const snapshot = activeSnapshot();
    window.sessionStorage.setItem("drawbackengine.localGameId", snapshot.gameId);
    vi.mocked(loadBootstrap).mockResolvedValue(bootstrap(snapshot));
    vi.mocked(loadGame)
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new PlayApiClientError(
        404,
        "not-found",
        "The local API route does not exist.",
      ));
    vi.mocked(submitAction).mockRejectedValueOnce(new PlayApiClientError(
      500,
      "internal-error",
      "The local engine could not complete that request.",
    ));

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
      await settle();
    });
    const submit = container.querySelector("button");
    if (submit === null) {
      throw new Error("Expected the mocked game action button.");
    }
    act(() => { submit.click(); });
    await waitForText("The local engine could not complete that request.");

    expect(container.textContent).not.toContain("The local API route does not exist.");
    expect(loadGame).toHaveBeenCalledTimes(2);
    expect(submitAction).toHaveBeenCalledOnce();
    expect(createGame).not.toHaveBeenCalled();
    expect(resignGame).not.toHaveBeenCalled();
    expect(retryEngine).not.toHaveBeenCalled();
  });
});

function activeSnapshot(): PlayGameSnapshot {
  const game = PlayerPrivatePlayGame.create({
    seed: 31,
    humanColor: "white",
    humanDrawbackId: "vegan",
    engineDrawbackId: "checkers",
  });
  return {
    schema: PLAY_WEB_API_VERSION,
    gameId: "game_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    observation: game.observation(),
    moves: [],
    strength: PLAY_STRENGTHS[1],
    evaluator: {
      kind: "Fairy-Stockfish",
      name: "Fairy-Stockfish test",
      version: "test",
      leafDepth: 2,
      hashMb: 16,
      threads: 1,
      multiPv: 1,
      limitStrength: false,
      skillLevel: 20,
      nnue: "disabled",
    },
    thinking: false,
    reveal: null,
  };
}

function bootstrap(snapshot: PlayGameSnapshot): PlayBootstrapResponse {
  return {
    schema: PLAY_WEB_API_VERSION,
    evaluator: snapshot.evaluator,
    strengths: PLAY_STRENGTHS,
    drawbacks: [{
      id: "vegan",
      name: "Vegan",
      description: "The player cannot capture an opposing knight.",
      verification: "implemented-unverified",
    }],
  };
}

async function waitForText(expected: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container?.textContent.includes(expected) === true) {
      return;
    }
    await act(settle);
  }
  throw new Error(`Timed out waiting for: ${expected}`);
}

function settle(): Promise<void> {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, 0); });
}
