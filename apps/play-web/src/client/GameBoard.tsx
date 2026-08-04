import { useEffect, useMemo, useRef, useState } from "react";
import {
  Chessboard,
  type ChessboardOptions,
} from "react-chessboard";
import type {
  PlayerPlayAction,
  PlayerPlayObservationV1,
} from "@drawbackengine/simulation-arena";
import {
  actionsFrom,
  actionsTo,
  boardPosition,
  boardPositionAfterAction,
  boardSquareStyles,
} from "./board-model.js";

interface GameBoardProps {
  readonly observation: PlayerPlayObservationV1;
  readonly disabled: boolean;
  readonly pendingAction: PlayerPlayAction | null;
  readonly onAction: (actionId: string) => void;
}

interface PromotionChoice {
  readonly from: string;
  readonly to: string;
  readonly actions: readonly PlayerPlayAction[];
}

export function GameBoard({
  observation,
  disabled,
  pendingAction,
  onAction,
}: GameBoardProps): React.JSX.Element {
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [orientation, setOrientation] = useState(observation.viewer);
  const [promotion, setPromotion] = useState<PromotionChoice | null>(null);
  const firstPromotionButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setSelectedSquare(null);
    setPromotion(null);
  }, [observation.ply, pendingAction]);

  useEffect(() => {
    if (promotion === null) {
      return;
    }
    firstPromotionButton.current?.focus();
    const cancel = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setPromotion(null);
      }
    };
    document.addEventListener("keydown", cancel);
    return () => { document.removeEventListener("keydown", cancel); };
  }, [promotion]);

  const position = useMemo(
    () => pendingAction === null
      ? boardPosition(observation)
      : boardPositionAfterAction(observation, pendingAction),
    [observation, pendingAction],
  );
  const squareStyles = useMemo(
    () => boardSquareStyles(observation, selectedSquare),
    [observation, selectedSquare],
  );

  const chooseMove = (from: string, to: string): boolean => {
    if (disabled) {
      return false;
    }
    const candidates = actionsTo(observation.actions, from, to);
    if (candidates.length === 0) {
      return false;
    }
    if (candidates.length === 1 && candidates[0]?.promotion === undefined) {
      const action = candidates[0];
      if (action === undefined) {
        return false;
      }
      setSelectedSquare(null);
      onAction(action.actionId);
      return true;
    }
    setPromotion({ from, to, actions: candidates });
    return false;
  };

  const options: ChessboardOptions = {
    id: "drawback-play-board",
    position,
    boardOrientation: orientation,
    showNotation: true,
    allowDragging: !disabled,
    allowDragOffBoard: false,
    allowDrawingArrows: true,
    clearArrowsOnClick: true,
    animationDurationInMs: 180,
    boardStyle: {
      borderRadius: "12px",
      boxShadow: "0 22px 60px rgba(0, 0, 0, 0.34)",
    },
    lightSquareStyle: { backgroundColor: "#d9d2bf" },
    darkSquareStyle: { backgroundColor: "#526863" },
    squareStyles,
    canDragPiece: ({ square }) =>
      !disabled
      && square !== null
      && actionsFrom(observation.actions, square).length > 0,
    onPieceDrop: ({ sourceSquare, targetSquare }) =>
      targetSquare !== null && chooseMove(sourceSquare, targetSquare),
    onSquareClick: ({ square }) => {
      if (disabled) {
        return;
      }
      if (selectedSquare !== null && chooseMove(selectedSquare, square)) {
        return;
      }
      setSelectedSquare(
        actionsFrom(observation.actions, square).length > 0 ? square : null,
      );
    },
  };

  return (
    <section className="board-panel" aria-labelledby="board-heading">
      <div className="board-heading-row">
        <div>
          <p className="eyebrow">Live position</p>
          <h2 id="board-heading">You are {capitalize(observation.viewer)}</h2>
        </div>
        <div className="board-heading-actions">
          <button
            className="flip-button"
            onClick={() => { setOrientation((current) => current === "white" ? "black" : "white"); }}
            type="button"
          >
            <span aria-hidden="true">↻</span> Flip board
          </button>
          <div className={`turn-chip ${pendingAction === null && observation.turn === observation.viewer ? "is-yours" : ""}`}>
            <span aria-hidden="true" className="turn-dot" />
            {pendingAction === null
              ? observation.turn === observation.viewer ? "Your turn" : "Engine turn"
              : "Engine thinking"}
          </div>
        </div>
      </div>
      <div
        className="board-frame"
        aria-label={`Chessboard, ${orientation} at the bottom`}
      >
        <Chessboard options={options} />
      </div>
      <p className="board-help" id="board-instructions">
        Drag a piece or select a square. Highlighted dots are drawback-legal moves.
        Keyboard players can use the move buttons below.
      </p>
      <div className="legal-move-strip" aria-label="Available legal moves">
        {observation.actions.length === 0 ? (
          <span className="muted">No player actions available.</span>
        ) : (
          observation.actions.map((action) => (
            <button
              className="move-chip"
              disabled={disabled}
              key={action.actionId}
              onClick={() => { onAction(action.actionId); }}
              type="button"
            >
              {formatAction(action)}
            </button>
          ))
        )}
      </div>
      {promotion !== null ? (
        <div className="dialog-backdrop" role="presentation">
          <div
            aria-labelledby="promotion-title"
            aria-modal="true"
            className="modal-card promotion-dialog"
            role="dialog"
          >
            <p className="eyebrow">Pawn promotion</p>
            <h2 id="promotion-title">Choose a piece</h2>
            <p>
              {promotion.from} to {promotion.to}
            </p>
            <div className="promotion-options">
              {promotion.actions.map((action, index) => (
                <button
                  className="promotion-button"
                  key={action.actionId}
                  onClick={() => {
                    setPromotion(null);
                    onAction(action.actionId);
                  }}
                  ref={index === 0 ? firstPromotionButton : undefined}
                  type="button"
                >
                  <span aria-hidden="true">{promotionGlyph(action.promotion)}</span>
                  {capitalize(action.promotion ?? "piece")}
                </button>
              ))}
            </div>
            <button
              className="text-button"
              onClick={() => { setPromotion(null); }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function formatAction(action: PlayerPlayAction): string {
  const promotion = action.promotion === undefined
    ? ""
    : `=${action.promotion.charAt(0).toUpperCase()}`;
  return `${action.from}–${action.to}${promotion}`;
}

function promotionGlyph(
  promotion: PlayerPlayAction["promotion"],
): string {
  switch (promotion) {
    case "queen":
      return "♛";
    case "rook":
      return "♜";
    case "bishop":
      return "♝";
    case "knight":
      return "♞";
    case undefined:
      return "?";
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
