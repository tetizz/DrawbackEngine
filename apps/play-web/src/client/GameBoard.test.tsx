// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChessboardOptions } from "react-chessboard";
import { PlayerPrivatePlayGame } from "@drawbackengine/simulation-arena";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameBoard } from "./GameBoard.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-chessboard", () => ({
  Chessboard: ({ options }: { readonly options: ChessboardOptions }) => (
    <div
      data-e2={pieceAt(options.position, "e2")}
      data-e4={pieceAt(options.position, "e4")}
      data-orientation={options.boardOrientation}
      data-testid="mock-board"
    >
      <button
        data-square="e2"
        onClick={() => options.onSquareClick?.({ piece: null, square: "e2" })}
        type="button"
      >e2</button>
      <button
        data-square="e4"
        onClick={() => options.onSquareClick?.({ piece: null, square: "e4" })}
        type="button"
      >e4</button>
    </div>
  ),
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

describe("GameBoard", () => {
  it("supports click-to-move, a keyboard move list, and local board flipping", () => {
    const game = PlayerPrivatePlayGame.create({
      seed: 8,
      humanColor: "white",
      humanDrawbackId: "vegan",
      engineDrawbackId: "checkers",
    });
    const observation = game.observation();
    const action = observation.actions.find(
      (candidate) => candidate.from === "e2" && candidate.to === "e4",
    );
    if (action === undefined) {
      throw new Error("Expected e2-e4.");
    }
    const onAction = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <GameBoard
          disabled={false}
          observation={observation}
          onAction={onAction}
          pendingAction={null}
        />,
      );
    });

    expect(container.querySelector("[data-testid='mock-board']")?.getAttribute("data-orientation"))
      .toBe("white");
    act(() => {
      (container?.querySelector("[data-square='e2']") as HTMLButtonElement).click();
    });
    act(() => {
      (container?.querySelector("[data-square='e4']") as HTMLButtonElement).click();
    });
    expect(onAction).toHaveBeenCalledWith(action.actionId);
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent.includes("e2–e4")),
    ).toBe(true);

    act(() => {
      root?.render(
        <GameBoard
          disabled
          observation={observation}
          onAction={onAction}
          pendingAction={action}
        />,
      );
    });
    const pendingBoard = container.querySelector("[data-testid='mock-board']");
    expect(pendingBoard?.getAttribute("data-e2")).toBe("");
    expect(pendingBoard?.getAttribute("data-e4")).toBe("wP");
    expect(container.textContent).toContain("Engine thinking");
    expect(container.textContent).not.toContain("Your turn");

    const flip = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Flip board"));
    if (flip === undefined) {
      throw new Error("Expected a Flip board button.");
    }
    act(() => { flip.click(); });
    expect(container.querySelector("[data-testid='mock-board']")?.getAttribute("data-orientation"))
      .toBe("black");
  });
});

function pieceAt(
  position: ChessboardOptions["position"],
  square: string,
): string {
  if (position === undefined || typeof position === "string") {
    return "";
  }
  return position[square]?.pieceType ?? "";
}
