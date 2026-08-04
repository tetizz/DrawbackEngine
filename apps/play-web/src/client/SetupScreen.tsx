import { useMemo, useState } from "react";
import type { PlayerColor } from "@drawbackengine/shared";
import type {
  CreatePlayGameRequest,
  PlayBootstrapResponse,
  PlayStrengthId,
} from "../shared/api.js";

interface SetupScreenProps {
  readonly bootstrap: PlayBootstrapResponse;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onStart: (request: CreatePlayGameRequest) => void;
}

export function SetupScreen({
  bootstrap,
  busy,
  error,
  onStart,
}: SetupScreenProps): React.JSX.Element {
  const [color, setColor] = useState<PlayerColor>("white");
  const [drawbackId, setDrawbackId] = useState(
    bootstrap.drawbacks[0]?.id ?? "",
  );
  const [strengthId, setStrengthId] = useState<PlayStrengthId>("balanced");
  const selectedDrawback = useMemo(
    () => bootstrap.drawbacks.find((drawback) => drawback.id === drawbackId),
    [bootstrap.drawbacks, drawbackId],
  );

  return (
    <main className="setup-shell">
      <header className="setup-hero">
        <div className="brand-mark" aria-hidden="true">D</div>
        <div>
          <p className="eyebrow">DrawbackEngine · local player-private match</p>
          <h1>Find out how strong it really is.</h1>
          <p className="hero-copy">
            Play a complete game against the real drawback-aware search. The
            engine knows its own drawback, not yours, and every move is enforced
            by the same audited rule session used by the simulator.
          </p>
        </div>
      </header>

      <section className="setup-grid" aria-label="New game settings">
        <div className="setup-main">
          {error === null ? null : (
            <div className="error-banner" role="alert">{error}</div>
          )}

          <fieldset className="choice-section">
            <legend>Choose your side</legend>
            <div className="segmented-control">
              {(["white", "black"] as const).map((candidate) => (
                <label key={candidate}>
                  <input
                    checked={color === candidate}
                    disabled={busy}
                    name="color"
                    onChange={() => { setColor(candidate); }}
                    type="radio"
                    value={candidate}
                  />
                  <span className="color-choice-piece" aria-hidden="true">
                    {candidate === "white" ? "♔" : "♚"}
                  </span>
                  {capitalize(candidate)}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="choice-section">
            <label className="field-label" htmlFor="drawback-select">
              Your drawback
            </label>
            <p className="field-hint">
              Local browser play currently uses the frozen audited 25-rule
              player-private catalog.
            </p>
            <select
              disabled={busy}
              id="drawback-select"
              onChange={(event) => { setDrawbackId(event.target.value); }}
              value={drawbackId}
            >
              {bootstrap.drawbacks.map((drawback) => (
                <option key={drawback.id} value={drawback.id}>
                  {drawback.name} · {drawback.verification}
                </option>
              ))}
            </select>
            {selectedDrawback === undefined ? null : (
              <div className="drawback-preview">
                <span className="verification-tag">{selectedDrawback.verification}</span>
                <p>{selectedDrawback.description}</p>
              </div>
            )}
          </div>

          <fieldset className="choice-section">
            <legend>Engine search preset</legend>
            <p className="field-hint">
              These are exact compute limits, not invented Elo ratings.
            </p>
            <div className="strength-grid">
              {bootstrap.strengths.map((strength) => (
                <label
                  className={strengthId === strength.id ? "strength-card selected" : "strength-card"}
                  key={strength.id}
                >
                  <input
                    checked={strengthId === strength.id}
                    disabled={busy}
                    name="strength"
                    onChange={() => { setStrengthId(strength.id); }}
                    type="radio"
                    value={strength.id}
                  />
                  <strong>{strength.label}</strong>
                  <span>{strength.summary}</span>
                  <code>
                    depth {strength.maxDepth} · {formatNumber(strength.maxNodes)} nodes
                  </code>
                </label>
              ))}
            </div>
          </fieldset>

          <button
            className="primary-button start-button"
            disabled={busy || selectedDrawback === undefined}
            onClick={() => { onStart({
              humanColor: color,
              humanDrawbackId: drawbackId,
              strengthId,
            }); }}
            type="button"
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {busy ? "Starting authenticated engine…" : "Start the game"}
          </button>
        </div>

        <aside className="engine-proof-card" aria-label="Configured evaluator">
          <p className="eyebrow">Actual evaluator</p>
          <h2>{bootstrap.evaluator.name}</h2>
          <p className="engine-version">
            {bootstrap.evaluator.kind} · version {bootstrap.evaluator.version}
          </p>
          <dl className="settings-list">
            <div><dt>Leaf depth</dt><dd>{bootstrap.evaluator.leafDepth}</dd></div>
            <div><dt>Hash</dt><dd>{bootstrap.evaluator.hashMb} MB</dd></div>
            <div><dt>Threads</dt><dd>{bootstrap.evaluator.threads}</dd></div>
            <div><dt>Skill Level</dt><dd>{bootstrap.evaluator.skillLevel}</dd></div>
            <div><dt>NNUE</dt><dd>{bootstrap.evaluator.nnue}</dd></div>
          </dl>
          <div className="privacy-note">
            <span aria-hidden="true">◈</span>
            <p>
              The executable and variant are authenticated before play. No
              opponent drawback, hidden state, file path, or search score is
              sent to this page.
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
