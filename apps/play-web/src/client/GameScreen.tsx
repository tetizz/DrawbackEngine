import { useEffect, useRef, useState } from "react";
import type { PlayerPlayAction } from "@drawbackengine/simulation-arena";
import type { PlayGameSnapshot, PlayMoveRecord } from "../shared/api.js";
import { GameBoard } from "./GameBoard.js";

export interface PendingHumanMove {
  readonly action: PlayerPlayAction;
  readonly fromPly: number;
}

interface GameScreenProps {
  readonly game: PlayGameSnapshot;
  readonly busy: boolean;
  readonly error: string | null;
  readonly pendingHumanMove: PendingHumanMove | null;
  readonly onAction: (actionId: string) => void;
  readonly onRetryEngine: () => void;
  readonly onResign: () => void;
  readonly onNewGame: () => void;
}

export function GameScreen({
  game,
  busy,
  error,
  pendingHumanMove,
  onAction,
  onRetryEngine,
  onResign,
  onNewGame,
}: GameScreenProps): React.JSX.Element {
  const [confirmResign, setConfirmResign] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const { observation } = game;
  const finished = observation.status.kind !== "active";
  const submittingHumanMove =
    busy
    && pendingHumanMove !== null
    && pendingHumanMove.fromPly === observation.ply;
  const engineTurn =
    !finished
    && (submittingHumanMove || observation.turn !== observation.viewer);

  useEffect(() => {
    if (!confirmResign) {
      return;
    }
    confirmButton.current?.focus();
    const cancel = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setConfirmResign(false);
      }
    };
    document.addEventListener("keydown", cancel);
    return () => { document.removeEventListener("keydown", cancel); };
  }, [confirmResign]);

  return (
    <main className="game-shell">
      <header className="game-topbar">
        <div className="compact-brand">
          <span className="brand-mark small" aria-hidden="true">D</span>
          <div>
            <span className="brand-title">DrawbackEngine</span>
            <span className="brand-subtitle">Local player-private game</span>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="strength-badge" aria-label="Selected engine search preset">
            <span>{game.strength.label}</span>
            <code>
              D{game.strength.maxDepth} · {formatNumber(game.strength.maxNodes)} nodes
            </code>
          </div>
          {finished ? (
            <button className="secondary-button" onClick={onNewGame} type="button">
              New game
            </button>
          ) : (
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => { setConfirmResign(true); }}
              type="button"
            >
              Resign
            </button>
          )}
        </div>
      </header>

      {error === null ? null : (
        <div className="game-error error-banner" role="alert">
          <span>{error}</span>
          {engineTurn ? (
            <button disabled={busy} onClick={onRetryEngine} type="button">
              Retry engine move
            </button>
          ) : null}
        </div>
      )}

      <div className="game-layout">
        <div className="board-column">
          {busy && engineTurn ? (
            <div className="thinking-banner" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <div>
                <strong>Engine is searching the real tree</strong>
                <span>
                  Depth {game.strength.maxDepth}, up to {formatNumber(game.strength.maxNodes)} outer nodes
                </span>
              </div>
            </div>
          ) : null}
          <GameBoard
            disabled={busy || finished || observation.turn !== observation.viewer}
            observation={observation}
            onAction={onAction}
            pendingAction={submittingHumanMove ? pendingHumanMove.action : null}
          />
        </div>

        <aside className="game-sidebar">
          <section className="sidebar-card drawback-card" aria-labelledby="own-drawback-title">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Your hidden rule</p>
                <h2 id="own-drawback-title">{observation.ownDrawback.name}</h2>
              </div>
              <span className="verification-tag">{observation.ownDrawback.verification}</span>
            </div>
            <p>{observation.ownDrawback.description}</p>
            {observation.ownDrawback.turnInstructions.length === 0 ? null : (
              <ul className="instruction-list">
                {observation.ownDrawback.turnInstructions.map((instruction) => (
                  <li key={instruction}>{instruction}</li>
                ))}
              </ul>
            )}
            <p className="secret-reminder">
              The engine cannot read this card or your hidden rule.
            </p>
          </section>

          {finished ? (
            <ResultCard game={game} onNewGame={onNewGame} />
          ) : (
            <section className="sidebar-card status-card" aria-live="polite">
              <p className="eyebrow">Game status</p>
              <h2>{engineTurn ? "Engine to move" : "Your move"}</h2>
              <p>
                {engineTurn
                  ? "The authenticated evaluator is scoring drawback-legal leaves."
                  : "Only moves permitted by ordinary chess and your drawback are shown."}
              </p>
            </section>
          )}

          <EngineSettings game={game} />
          <MoveList moves={game.moves} />
        </aside>
      </div>

      {confirmResign ? (
        <div className="dialog-backdrop" role="presentation">
          <div
            aria-labelledby="resign-title"
            aria-modal="true"
            className="modal-card"
            role="dialog"
          >
            <p className="eyebrow">End game</p>
            <h2 id="resign-title">Resign this game?</h2>
            <p>The opponent’s drawback will be revealed after resignation.</p>
            <div className="modal-actions">
              <button
                className="danger-button"
                onClick={() => {
                  setConfirmResign(false);
                  onResign();
                }}
                ref={confirmButton}
                type="button"
              >
                Resign and reveal
              </button>
              <button
                className="secondary-button"
                onClick={() => { setConfirmResign(false); }}
                type="button"
              >
                Keep playing
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function EngineSettings({ game }: { readonly game: PlayGameSnapshot }): React.JSX.Element {
  return (
    <section className="sidebar-card settings-card" aria-labelledby="engine-settings-title">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Verified move path</p>
          <h2 id="engine-settings-title">{game.evaluator.name}</h2>
        </div>
        <span className="live-pill">LOCAL</span>
      </div>
      <dl className="settings-list compact">
        <div><dt>Outer depth</dt><dd>{game.strength.maxDepth}</dd></div>
        <div><dt>Outer node cap</dt><dd>{formatNumber(game.strength.maxNodes)}</dd></div>
        <div><dt>Leaf depth</dt><dd>{game.evaluator.leafDepth}</dd></div>
        <div><dt>Hash / threads</dt><dd>{game.evaluator.hashMb} MB / {game.evaluator.threads}</dd></div>
        <div><dt>Knowledge</dt><dd>Player-private</dd></div>
      </dl>
      <p className="settings-footnote">
        Search preset means exact compute limits, not a claimed Elo.
      </p>
    </section>
  );
}

function MoveList({ moves }: { readonly moves: readonly PlayMoveRecord[] }): React.JSX.Element {
  return (
    <section className="sidebar-card move-list-card" aria-labelledby="move-list-title">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Game record</p>
          <h2 id="move-list-title">Moves</h2>
        </div>
        <span className="move-count">{moves.length}</span>
      </div>
      {moves.length === 0 ? (
        <p className="muted">The game has not started.</p>
      ) : (
        <ol className="move-list">
          {moves.map((move) => (
            <li key={move.ply}>
              <span className={`move-color ${move.color}`} aria-hidden="true" />
              <span>{move.color === "white" ? "White" : "Black"}</span>
              <strong>{formatMove(move)}</strong>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ResultCard({
  game,
  onNewGame,
}: {
  readonly game: PlayGameSnapshot;
  readonly onNewGame: () => void;
}): React.JSX.Element {
  const status = game.observation.status;
  if (status.kind === "active") {
    throw new Error("ResultCard requires a finished game.");
  }
  const title = status.kind === "draw"
    ? "Game drawn"
    : `${capitalize(status.winner)} wins`;
  const reason = status.reason.replaceAll("-", " ");
  return (
    <section className="sidebar-card result-card" aria-labelledby="result-title">
      <p className="eyebrow">Final result</p>
      <h2 id="result-title">{title}</h2>
      <p>By {reason}.</p>
      {game.reveal === null ? null : (
        <div className="reveal-grid">
          <Reveal color="White" drawback={game.reveal.white} />
          <Reveal color="Black" drawback={game.reveal.black} />
        </div>
      )}
      <button className="primary-button" onClick={onNewGame} type="button">
        Play another game
      </button>
    </section>
  );
}

function Reveal({
  color,
  drawback,
}: {
  readonly color: string;
  readonly drawback: NonNullable<PlayGameSnapshot["reveal"]>["white"];
}): React.JSX.Element {
  return (
    <div className="reveal-row">
      <span>{color}</span>
      <strong>{drawback.name}</strong>
      <small>{drawback.verification}</small>
      {drawback.details.map((detail) => <p key={detail}>{detail}</p>)}
    </div>
  );
}

function formatMove(move: PlayMoveRecord): string {
  const promotion = move.promotion === undefined
    ? ""
    : `=${move.promotion.charAt(0).toUpperCase()}`;
  return `${move.from}–${move.to}${promotion}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
