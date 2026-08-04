// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlayerPrivatePlayGame } from "@drawbackengine/simulation-arena";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAY_STRENGTHS,
  PLAY_WEB_API_VERSION,
  type PlayGameSnapshot,
} from "../shared/api.js";
import { GameScreen } from "./GameScreen.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./GameBoard.js", () => ({
  GameBoard: () => <div data-testid="game-board" />,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("GameScreen", () => {
  it("announces that the engine is thinking while a submitted human move is pending", () => {
    const game = PlayerPrivatePlayGame.create({
      seed: 8,
      humanColor: "white",
      humanDrawbackId: "vegan",
      engineDrawbackId: "checkers",
    });
    const snapshot: PlayGameSnapshot = {
      schema: PLAY_WEB_API_VERSION,
      gameId: "test-game",
      observation: game.observation(),
      moves: [],
      strength: PLAY_STRENGTHS[0],
      evaluator: {
        kind: "Fairy-Stockfish",
        name: "Fairy-Stockfish",
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
    const pendingAction = snapshot.observation.actions.find(
      (action) => action.from === "e2" && action.to === "e4",
    );
    if (pendingAction === undefined) {
      throw new Error("Expected e2-e4.");
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <GameScreen
          busy
          error={null}
          game={snapshot}
          onAction={vi.fn()}
          onNewGame={vi.fn()}
          onResign={vi.fn()}
          onRetryEngine={vi.fn()}
          pendingHumanMove={{ action: pendingAction, fromPly: snapshot.observation.ply }}
        />,
      );
    });

    expect(container.textContent).toContain("Engine is searching the real tree");
    expect(container.textContent).toContain("Engine to move");
    expect(container.textContent).not.toContain("Your move");
  });
});
