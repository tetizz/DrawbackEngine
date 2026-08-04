// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAY_STRENGTHS,
  PLAY_WEB_API_VERSION,
  type PlayBootstrapResponse,
} from "../shared/api.js";
import { SetupScreen } from "./SetupScreen.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("SetupScreen", () => {
  it("submits the selected engine strength instead of only changing its label", () => {
    const onStart = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <SetupScreen
          bootstrap={bootstrap()}
          busy={false}
          error={null}
          onStart={onStart}
        />,
      );
    });

    const deep = container.querySelector<HTMLInputElement>(
      "input[name='strength'][value='deep']",
    );
    if (deep === null) {
      throw new Error("Expected the Deep strength control.");
    }
    act(() => { deep.click(); });
    const start = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Start the game")
    );
    if (start === undefined) {
      throw new Error("Expected the start-game control.");
    }
    act(() => { start.click(); });

    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledWith({
      humanColor: "white",
      humanDrawbackId: "vegan",
      strengthId: "deep",
    });
    expect(container.textContent).toContain("depth 3 · 250,000 nodes");
  });
});

function bootstrap(): PlayBootstrapResponse {
  return {
    schema: PLAY_WEB_API_VERSION,
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
    strengths: PLAY_STRENGTHS,
    drawbacks: [{
      id: "vegan",
      name: "Vegan",
      description: "You cannot capture knights.",
      verification: "implemented-unverified",
    }],
  };
}
