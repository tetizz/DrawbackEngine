# Player-scoped observation policy

## Purpose

Drawback rules can restrict not only what a player may do, but also what that
player may observe. Fog of War is the first known rule that requires this
boundary:

> You cannot see the opponent's pieces, but you can see whether a possible move
> is a capture or king capture, and you know when you are in check.

The quoted wording is incomplete. In particular, “king capture” may mean a
capture made by the king, a move that could capture the opposing king under the
source site's checkless variant, or another UI affordance. Until replay evidence
resolves that ambiguity, this document defines the security boundary and a
conservative observation shape, not executable Fog of War game semantics.

The governing rule is:

> A player-facing component receives only the observation authorized for that
> player. It never receives an authoritative position and then hides fields in
> rendering.

CSS, board-piece opacity, React conditional rendering, prompt instructions, and
agent convention are not security boundaries.

## Trust domains

### Authoritative engine

`GameSession`, standard move generation, drawback rules, and result evaluation
are trusted. They may hold:

- the complete board and FEN;
- both drawbacks, parameters, and internal states;
- ordinary and drawback-legal moves with captured piece types;
- complete move history;
- deterministic simulation seeds.

This information stays inside the engine boundary. Existing
`PositionView`, `MoveObservation`, and `exportSecretSnapshot()` are trusted
internal or label-generation types; they are not player view contracts.

### Player principal

Each request is evaluated for a principal:

```ts
type ObservationPrincipal =
  | { readonly kind: "player"; readonly color: PlayerColor }
  | { readonly kind: "public-spectator" }
  | { readonly kind: "post-game-analysis" }
  | { readonly kind: "trusted-training-export" };
```

White and Black projections are generated independently. Giving White a view
that is safe for Black, or vice versa, is not valid. If both players have
observation drawbacks, both policies apply independently.

`post-game-analysis` is available only after a terminal result and an explicit
reveal decision. `trusted-training-export` is an offline data-labeling
capability and must never be reachable from a player UI or agent callback.

### Predictor

The predictor is an observer, not an engine capability. Its input must be the
evidence actually available to the selected prediction scenario:

- a public-observer predictor receives only public events;
- a player-assistant predictor receives only that player's observations;
- an offline evaluator may consume an authoritative replay, but its output
  must not be returned during a hidden-information game.

A predictor must represent missing information explicitly. It may infer hidden
pieces probabilistically, but must not receive a full FEN, full legal set, SAN,
or other authoritative value and call it “unknown” after feature generation.

## Contracts

The player contract should be a discriminated, versioned projection rather than
a weakened `PositionView`.

```ts
interface PlayerObservationV1 {
  readonly schema: "player-observation/v1";
  readonly viewer: PlayerColor;
  readonly turn: PlayerColor;
  readonly ply: number;
  readonly board: readonly ObservedSquare[];
  readonly actions: readonly PlayerAction[];
  readonly status: PlayerStatus;
  readonly events: readonly PlayerEvent[];
  readonly ownDrawback: OwnDrawbackDisclosure;
}

type ObservedSquare =
  | {
      readonly square: Square;
      readonly visibility: "known";
      readonly occupant: ObservedPiece | null;
    }
  | {
      readonly square: Square;
      readonly visibility: "masked";
    };

interface ObservedPiece {
  readonly color: PlayerColor;
  readonly type: PieceType;
}

interface PlayerAction {
  readonly actionId: string;
  readonly from: Square;
  readonly to: Square;
  readonly promotionChoices?: readonly PromotionPiece[];
  readonly affordance: "quiet" | "capture" | "king-capture";
}

interface PlayerStatus {
  readonly active: boolean;
  readonly inCheck: boolean;
  readonly result?: PublicResult;
}
```

`actionId` is an opaque, single-position token bound to session ID, principal,
ply, origin, destination, promotion, and a server-side nonce or MAC. The player
submits the token, not a trusted `ChessMove`. Tokens expire after any state
change and cannot be replayed for the other color.

The engine may expose `from`, `to`, and promotion choices because the player
must operate the board. It must not expose `piece`, `captured`, SAN, check or
mate suffixes, ordinary legal alternatives, rule-trigger counts, or hidden
parameters unless a specific observation policy authorizes each value.
`affordance` deliberately reveals only the category promised by Fog of War,
not the captured piece type.

The contract contains no FEN. FEN cannot encode an unknown square and is too
easy to forward accidentally to Stockfish, replay code, browser logs, or model
features.

## Projection and masking semantics

For a player affected by the conservative Fog of War policy:

1. Every own piece and its square is `known`.
2. Every square occupied by an opposing piece is `masked`; the projection does
   not reveal its color, type, or occupancy.
3. An empty square is `known` only if the source rule is confirmed to reveal
   emptiness. Until then, all non-own squares are `masked`. This avoids leaking
   occupancy through a distinction between empty and hidden-occupied squares.
4. Legal origins, destinations, promotion choices, and the permitted capture
   affordance are computed by the trusted engine and projected as actions.
5. `inCheck` is authoritative and visible, as stated by the observed rule.
6. Check source, attack ray, checking piece type, and check/mate SAN suffixes
   are not visible.
7. The opponent's chosen move is emitted only at the minimum granularity proven
   visible by source evidence. Until then, use a generic
   `opponent-move-completed` event and the next board projection. Do not include
   SAN, UCI, origin, destination, capture victim, promotion, or castling flags.
8. Captured own pieces disappear from the next projection. This unavoidable
   state change is evidence, but no extra attacker identity is supplied.
9. The viewer's own drawback description and non-secret per-turn disclosure
   remain visible. The opponent's drawback, parameters, and state remain
   hidden.

When the viewer is not affected by Fog of War, another policy may provide a
complete board. The projection service must still return the typed player
contract rather than raw engine objects, so adding a later observation rule
does not reopen the boundary.

Masking is monotonic within one observation: serialization, rendering,
accessibility output, logging, analytics, and agent invocation may remove more
information, but may not enrich the projection.

## Evidence gaps and prediction

Hidden-information observations are not equivalent to ordinary public chess
records. The event stream must retain what was and was not observable:

```ts
interface ObservationEvidenceV1 {
  readonly schema: "observation-evidence/v1";
  readonly principal: ObservationPrincipal;
  readonly ply: number;
  readonly board: readonly ObservedSquare[];
  readonly visibleAction?: PlayerActionSummary;
  readonly evidenceGaps: readonly EvidenceGap[];
}

type EvidenceGap =
  | "opponent-piece-occupancy"
  | "opponent-piece-type"
  | "opponent-move-origin"
  | "opponent-move-destination"
  | "captured-target-type"
  | "ordinary-legal-move-set"
  | "san"
  | "check-source";
```

Symbolic elimination may use only facts present in the evidence object. A
hypothesis must not be eliminated because a hidden move or hidden board fact
would have contradicted it. Unknown evidence contributes neutral likelihood,
not negative evidence. Neural features need an explicit unknown mask alongside
piece planes; zero-filled hidden squares without a mask falsely mean empty.

The current predictor requires `PositionView` before/after and
`ordinaryLegalMoves`. It is therefore authoritative-board-only and is not
compatible with live player-scoped Fog observations. A new observation-aware
predictor adapter is required before enabling predictions in such sessions.
The current predictor may remain valid for offline omniscient evaluation if
that mode is labeled and its output is withheld until post-game analysis.

## Enforcement boundaries

The projection must be created in `chess-core` or an adjacent framework-free
package immediately after trusted move generation. React, CLI code, worker
messages, and simulation agents consume the projection; none may call
`session.fen`, `session.history()`, `session.ordinaryLegalMoves()`,
`session.legalMoves()`, or `exportSecretSnapshot()` for player presentation.

Recommended capability split:

```text
GameSession (trusted)
  -> projectFor(principal) -> PlayerObservationV1
  -> exportPublicReplay()  -> principal-scoped evidence stream
  -> exportSecretLabels()  -> trusted offline dataset writer only
```

The action-submission endpoint validates the opaque action token and applies
the associated trusted move. Rejections use non-oracular messages such as
“action is no longer available.” They must not distinguish a hidden blocker,
check exposure, drawback restriction, or token mismatch.

Do not place trusted session objects, callbacks closing over them, source maps
containing snapshots, or full observations in:

- React props, state, context, query caches, or developer-facing error objects;
- browser worker messages or `postMessage` payloads;
- Redux/devtools or telemetry;
- HTTP responses, GraphQL errors, server-rendered hydration data, or page HTML;
- agent views or UCI commands;
- player-downloadable replay files before reveal.

## Agent compatibility

Current `AgentView` is not Fog-safe because it contains full FEN, full
`ChessMove` objects, and full history.

| Agent | Compatibility | Required change |
| --- | --- | --- |
| Random legal | Compatible after adaptation | Select an opaque action uniformly. |
| Temperature/human-like | Partial | Score only visible origin, destination, promotion, capture affordance, status, and permitted history. |
| Greedy material | Incompatible as written | It reads the captured piece type; replace with capture/no-capture utility or a belief-state agent. |
| Stockfish | Incompatible | UCI FEN reveals the board. Do not invoke Stockfish for a Fog-scoped player. A separate information-set engine would be required. |
| Diagnostic probing | Incompatible as written | Current search clones the authoritative position and opponent hypotheses. Use only a belief-state search whose output is checked for leakage. |
| Remote/custom agent | Deny by default | Pass a serialized `PlayerObservationV1`; never grant a session handle. |

Sync and async simulation loops must call the same projection function. Tests
must compare their serialized views for identical seeds and positions.

## Web UI, replay, and accessibility

The current web board accepts full FEN, replays `fenBefore`, derives check from
the board, and highlights moves from full `ChessMove` values. Fog support must
replace that path with an observed-square renderer and player actions.

- Masked squares use a stable neutral treatment that does not encode occupancy
  in DOM structure, CSS class, tooltip, animation, cursor, image request, or
  timing.
- Piece nodes for hidden opponents must not exist under `display: none`,
  opacity zero, clipping, or an overlay.
- Legal highlighting may distinguish only the allowed affordance categories.
- Last-move arrows are omitted unless that move geometry is explicitly
  observable.
- Check announces “Your king is in check”; it does not identify direction or
  attacker.
- Screen-reader names for masked squares are identical (“unknown square D5”),
  whether empty or occupied. The accessibility tree must not contain hidden
  piece alt text, labels, descriptions, live-region messages, or promotion
  details.
- Keyboard navigation exposes the same actions as pointer input and no extra
  disabled destinations.
- Posterior panels and diagnostic arrows are disabled unless their inputs and
  explanations are derived solely from the viewer's evidence.

Live replay is principal-scoped. Scrubbing backward must reconstruct the view
that the same principal had at that ply, not render `fenBefore`. Switching
between White and Black views requires a new authorization decision, not board
orientation. Post-game reveal creates a separate immutable analysis replay;
it must not mutate or retroactively enrich the stored player evidence stream.

## Dataset and logging separation

Simulation currently combines authoritative observations and secret labels in
one in-memory result and emits full FEN, both legal sets, hidden parameters,
and rule state in dataset rows. That format is appropriate only for trusted
offline training storage.

Introduce distinct record types and sinks:

- `PlayerEvidenceRecord`: the exact versioned projection delivered to one
  principal;
- `PublicReplayRecord`: evidence authorized for spectators;
- `AuthoritativeTrainingRecord`: full board, legal masks, labels, and secrets;
- `PostGameAnalysisRecord`: explicitly revealed data with reveal policy and
  timestamp.

Label attachment occurs after player/public records have been serialized and
validated. Production logs default to identifiers, schema version, ply,
latency, and error class. They exclude FEN, SAN, action-token payloads,
candidate actions, board arrays, histories, drawbacks, parameters, internal
states, seeds, predictor features, and UCI transcripts.

Debug logging of authoritative data requires an offline-only build flag, a
non-player environment, bounded retention, and a visible warning. Redaction
after interpolation is insufficient.

## Required leakage tests

### Contract and engine

- White and Black projections from the same position differ only according to
  their own policies and never share mutable arrays or objects.
- A Fog projection contains no FEN-shaped string, opponent piece symbol/type,
  captured type, SAN, UCI move, ordinary move set, secret, or seed.
- Occupied and empty masked squares serialize identically.
- Action tokens are principal-, session-, and ply-bound, expire on transition,
  and produce non-oracular errors.
- A player can submit every projected action, and cannot submit an
  unprojected action.
- Sync and async simulations deliver byte-equivalent views.

### UI and accessibility

- DOM snapshots, React state inspection, worker messages, hydration payloads,
  clipboard/export data, and network traces contain no hidden piece data.
- Accessibility-tree snapshots for positions differing only under the fog are
  identical.
- Pointer, drag, keyboard, and promotion flows expose the same action set.
- Replay at every ply reproduces the historical principal-scoped projection.
- Board flip changes coordinates only; it never changes visibility.
- Error, notice, check, capture, and game-over announcements reveal no attacker
  or hidden target type.

### Agents, predictor, and operations

- Agent callbacks receive a deeply frozen projection and no object capable of
  reaching `GameSession`.
- Stockfish/UCI and diagnostic search are never called for an incompatible
  principal; spies assert zero calls.
- Predictor elimination is unchanged when only an unobservable hidden fact is
  varied.
- Unknown board masks reach model features and are not encoded as empty.
- Structured logs and thrown errors pass a deny-list scan for FEN, SAN,
  secrets, hidden pieces, action-token internals, and UCI commands.
- Trusted label exports remain deterministic but cannot be imported by browser
  or player-agent package dependency graphs.

Property tests should generate pairs of authoritative positions with identical
player projections and assert observational equivalence across serialization,
rendering semantics, agents, predictor inputs, logs, and rejection behavior.

## Migration plan

1. **Name the trusted types.** Mark current `PositionView`,
   `chess-core.MoveObservation`, simulation records, and dataset rows as
   authoritative. Add import-boundary lint rules preventing web and agent
   packages from consuming trusted exports.
2. **Add projection contracts.** Create a framework-free observation package
   with versioned square, action, status, event, and evidence-gap types. Add a
   single `projectFor(principal)` implementation and deep-freeze its output.
3. **Tokenize commands.** Replace player-submitted move objects with
   position-bound opaque action IDs. Retain direct `MoveCommand` only for
   trusted tests and replay ingestion.
4. **Split records.** Separate player/public evidence from authoritative
   training labels and provide different serialization APIs and storage
   locations.
5. **Adapt safe agents.** Migrate random legal first, then visible-feature
   temperature agents. Explicitly reject greedy-material, Stockfish, and
   current diagnostic agents under Fog rather than silently giving them FEN.
6. **Adapt the web board.** Render observed squares directly, remove FEN from
   player React state and props, implement accessibility-safe masking, and
   rebuild replay from principal-scoped evidence.
7. **Add observation-aware prediction.** Consume evidence gaps and unknown
   masks. Keep omniscient evaluation offline and label its metrics separately.
8. **Implement Fog semantics only after evidence review.** Resolve empty-square
   visibility, opponent move visibility, “king capture,” checkmate/check rules,
   en-passant, castling, and promotion observations. Keep the catalog status
   `unsupported` until these are executable and tested.
9. **Enforce with leakage gates.** Run contract, property, DOM, accessibility,
   agent-spy, logging, replay, and dependency-boundary tests in CI before
   enabling the rule in games.

## Acceptance criteria

Fog of War may move from `unsupported` only when:

- no player-facing or agent-facing path receives authoritative FEN or history;
- all legal interaction is mediated by player-scoped opaque actions;
- evidence ambiguities are resolved and documented;
- current incompatible agents and predictors fail closed;
- replay, post-game reveal, dataset, and logs use distinct capabilities;
- cross-color, DOM, accessibility, serialization, logging, and timing leakage
  tests pass;
- a security review confirms that identical player observations remain
  observationally equivalent throughout the application.
