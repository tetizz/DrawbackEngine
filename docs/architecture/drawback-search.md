# Drawback-aware search

## Current executable milestone

The repository now contains a real variant tree search rather than asking
Stockfish to choose from a drawback-filtered root list.

- `CapturableKingPosition` is the board authority for the live site's core
  movement rules.
- `DrawbackGameSession` combines that authority with the existing per-player
  rule runtimes and can fork board, history, parameters, and state without
  mutating its parent.
- `searchOmniscientDrawbackMove` runs deterministic alpha-beta minimax over
  those forks. Its input type is the exact `DrawbackGameSession`, which carries
  the `omniscient-oracle` capability marker.
  Every searched ply regenerates authority moves, applies the active player's
  drawback filter, transitions that player's rule state, and evaluates the next
  start-of-turn loss.
- `createStockfishLeafEvaluator` uses a fixed-depth Stockfish query only after
  the exact outer tree reaches a leaf. It resets the borrowed UCI client for
  each cold evaluation and requires every exact drawback-legal root to be
  representable by Stockfish.
- Non-orthodox leaves and mixed orthodox/variant root sets fail closed with an
  explicit `UnsupportedDrawbackLeafError`. Callers that need full variant
  coverage must deliberately select the drawback material evaluator instead;
  the Stockfish adapter never silently changes evaluators or hides legal moves.
- `initializeFairyStockfishLeafEvaluator` is the optional non-orthodox heuristic.
  It requires a runtime-branded verification of the exact regular,
  non-symlink `VariantPath` bytes, accepts the exact outer root mask, and
  evaluates king-capture chess without treating checkmate as the objective.
  The real Fairy-Stockfish 14 binary has validated the configuration and a
  non-orthodox smoke position. The site's special castling
  king-en-passant right remains outside the Fairy format and fails closed while
  active.
- `searchIterativeOmniscientDrawbackMove` never publishes a partially searched
  root. It scores every root with a full window, retains the deepest completely
  finished iteration, exposes exact root scores for reproducible
  temperature-based self-play, and fails with
  `IncompleteDrawbackSearchError` if depth one cannot fit the node budget.
- `createCachingLeafEvaluator` provides a bounded LRU for resolved engine
  scores. Its default key includes the full public history as well as FEN,
  authority, exact legal mask, and non-FEN variant state. Stockfish/Fairy
  callers may explicitly attest history-independent leaf behavior to share
  evaluations across equivalent public leaves.

This means future forced captures, cooldowns, history restrictions, deadlines,
and drawback losses are visible to the outer search. Stockfish does not get to
override the rule engine.

Rules must explicitly declare `capturable-king/v1` support. The audited
player-private set is Vegan, Lame Duck, Checkers, Truant, Spice of Life,
Femme Fatale, Nurturer, Triple Play, You Best Not Miss, and Irresistible.
Unrestricted remains a test control but is not a hidden label. A legacy rule
with no declaration is rejected at session creation instead of being
evaluated with accidental `chess.js` assumptions. Broader rule certification
is part of the remaining migration.

## King capture semantics

The implementation follows the public **How To Play** text served by
<https://www.drawbackchess.com/> as inspected on 2026-07-24:

- checkmate and stalemate do not end the game;
- a player may ignore an attack on their king;
- a pinned piece may move;
- a king may move into attack;
- directly capturing the opposing king ends the game immediately;
- castling may leave or cross attacked squares; on the opponent's immediately
  following move, the king can be captured by a move to an attacked square it
  left or crossed (its home square or the rook's landing square).

The castling-en-passant right expires when the opponent makes a different move.
Direct king capture and castling-en-passant king capture take precedence over
the next player's start-of-turn drawback loss.

### Documented interpretation

The public text does not specify whether both castling transit squares become
capture targets when only one was attacked. The implementation records only
the home/transit squares that were actually attacked during the castle. This
matches the en-passant analogy and is marked as an interpretation until a
first-party replay settles the edge.

## Knowledge boundary

The first search API is deliberately labeled:

```text
knowledgeMode = omniscient-oracle
```

It is an engine-authority and offline-analysis tool. A fork contains both
players' exact rule runtimes, so it must not be passed to a player agent, the
normal training input, or a live-game helper.

`searchPlayerPrivateDrawbackMove` is the fair player engine. It receives:

1. the player's own exact drawback capability;
2. public board and move history;
3. the public predictor distribution for the opponent;
4. one independently cloned runtime per surviving opponent hypothesis.

Aggregation is explicit and has two modes:

- `worst-case` takes the union of replies permitted by any positive-mass
  hypothesis and minimizes over that union. This remains the production
  safety policy.
- `posterior-expected` treats every hypothesis as a private-rule world. The
  opponent minimizes over the replies legal in that world, and the root
  averages those world-specific minima by public posterior mass. Start-of-turn
  loss and empty-mask worlds contribute terminal score rather than
  disappearing. Each observable reply is searched once, and its child
  posterior is conditioned by exact legality.

Expected-value opponent nodes use full child windows because ordinary
alpha-beta bounds are unsound for a weighted sum of independently minimizing
worlds. The principal variation is explanatory: it follows the reply selected
by the greatest posterior mass, with a stable coordinate tie-break.

The API cannot accept a `DrawbackGameSession`; it accepts only a complete
public board snapshot, an opaque own-rule capability, and public opponent
hypothesis capabilities. Own and opponent capabilities carry distinct
module-private runtime brands and are bound to one exact public position.
Opponent capabilities are reconstructed from a public candidate rule,
candidate parameters, and public history; their factory accepts neither a game
session nor authoritative internal state. Structurally forged or stale
capabilities are rejected. Literal and castling-en-passant king captures are
terminal in this tree.

## Determinism and limits

Search uses stable coordinate move ordering, iterative outer depth, fixed
Stockfish/Fairy leaf depth, a total outer node budget, mate-distance terminal
scores, sequential leaf evaluation, and `AbortSignal` cancellation. Partial
outer iterations are discarded. Completed leaf depth iterations are required
because a fixed-node UCI stop can return only an aspiration-window bound, which
is rejected rather than treated as an exact minimax value. A full-node
transposition table is intentionally absent: FEN alone is not a safe key
because drawback rule state and repetition history can change legal futures.
The leaf cache is narrower: it memoizes only the heuristic evaluation after the
exact outer engine has already derived the current legal mask and terminal
state.

The `oracle:move` CLI requires an explicit engine executable path and expected
SHA-256 digest, verifies the binary before launch, and prints an offline-oracle
warning before its result. `--engine-kind fairy-stockfish` additionally
requires the authenticated `--variant-path`; ordinary Stockfish remains
available for orthodox-compatible leaves.

## Player-private self-play

`simulation-arena` now has a separate capturable-king self-play path. It does
not reuse the orthodox `AgentView` or `GameSession`. The trusted coordinator
mints only the active player's exact `OwnPlayerRuleCapability`, reconstructs
opponent hypotheses from the authenticated public trace, and passes those
capabilities to an asynchronous player-private agent. Raw rules, opponent
parameters, opponent state, sessions, and game seeds are not part of that
callback.

Iterative search completes and scores every root before temperature sampling.
Partial deeper iterations are discarded, and an incomplete first iteration or
evaluator failure ends the simulation rather than falling back to a weaker
agent. Worker requests contain a serializable fixed-node policy; each worker
constructs its own evaluator and runtime capabilities. Explicit assignments
remain byte-identical across worker counts.

The player-private catalog currently contains 25 rules audited for
`capturable-king/v1`: the complete 20-rule initial milestone plus five rules
whose definitions explicitly depend on literal king capture. Unsupported
rules fail closed. The default public
opponent model is the unrestricted hypothesis; a predictor can supply a
public-only posterior without changing the agent boundary.

The opt-in `audited-opponent-v1` simulation profile replaces that control with
an equal prior over all 25 audited labels. Triple Play's bishop and knight
parameter particles split one label's mass rather than counting as two labels.
Before every turn, each candidate runtime is reconstructed solely from the
authenticated public replay. A candidate that had already lost or forbids an
observed move is symbolically eliminated, and the remaining mass is
renormalized. Authority-replay or final-position divergence still aborts
generation instead of being mistaken for evidence. This is a public-only
opponent model; it does not read either true opponent secrets or a learned
posterior. Its named production profile explicitly keeps `worst-case`. The
probability-aware mode is available for controlled research but is not the
default because its first fresh validation-position comparison was worse on
the only changed move.

Player-private results are privileged engine records. They retain initial and
final secret snapshots for both colors so a game ending before one side moves
still has complete labels. Those snapshots never enter an agent callback.
Worker responses are accepted only when assignment labels, complete policy
metadata, hypothesis-policy ID, ply/FEN continuity, terminal payload, and ply
limit all match the immutable request.

The `king-capture-diagnostics-v1` corpus profile adds label-independent public
starting positions to the same worker boundary. Its eight symmetric positions
exercise queen-versus-non-queen captures, bishop/knight material thresholds,
promotion unlocks, and next-turn check obligations. Scenario choice comes from
gameplay randomness rather than label or hidden-parameter randomness, and the
worker response must reproduce the assigned canonical FEN exactly.

`createPlayerPrivateSimulationTrace` now projects those results into the
separate `drawbackengine-player-private-simulation-trace` version 2 contract.
It records complete capturable authority snapshots, including king-passant
state, and passes every record through a semantic parser that rebuilds the
parameters, state transitions, legal masks, moves, and terminal result through
the executable session. The orthodox trace version remains unchanged.

## Remaining integration

- Add the leakage-checked capturable dataset adapter in DrawbackGuesser before
  these records are accepted into neural-model training.
- Bind evaluator and hypothesis-manifest digests into trace provenance.
- Extend the capturable authority audit beyond the initial milestone and five
  literal-king-capture rules.
- Replace the equal audited prior with a calibrated public Guesser posterior
  after its held-out reliability is adequate.
- Add evaluator-backed drawbacks without weakening the private capability
  boundary.
- Migrate the browser controller to capturable-king observations.

The ordinary simulation corpus remains on the orthodox compatibility session.
No variant game is silently mislabeled as standard training data.
