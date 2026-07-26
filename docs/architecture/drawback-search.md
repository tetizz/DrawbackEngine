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

Rules must explicitly declare `capturable-king/v1` support. The first audited
set is Unrestricted (test control), Vegan, Lame Duck, Checkers, Truant, and
Spice of Life. A legacy rule with no declaration is rejected at session
creation instead of being evaluated with accidental `chess.js` assumptions.
Broader rule certification is part of the remaining migration.

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

The initial aggregation is explicit worst case: opponent nodes take the union
of replies permitted by any positive-mass public hypothesis, merge identical
observable replies, remove incompatible hypotheses, and normalize the
remaining public mass. The API cannot accept a `DrawbackGameSession`; it
accepts only a complete public board snapshot, an opaque own-rule capability,
and public opponent hypothesis capabilities. Own and opponent capabilities
carry distinct module-private runtime brands and are bound to one exact public
position. Opponent capabilities are reconstructed from a public candidate
rule, candidate parameters, and public history; their factory accepts neither
a game session nor authoritative internal state. Structurally forged or stale
capabilities are rejected. Literal and castling-en-passant king captures are
terminal in this tree. Expected-policy and risk-sensitive aggregation remain
deferred until a calibrated public reply policy exists.

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

## Remaining integration

- Migrate the browser controller and simulator dataset schema to
  `capturable-king/v1` authority observations.
- Adapt the authority-aware symbolic posterior into executable public
  hypothesis capabilities for the web and simulation controllers.
- Extend the asynchronous session path for evaluator-backed drawbacks.
- Version the capturable-king simulation rows before they are accepted into
  neural-model training data.

Until those items land, the existing web controller and ordinary simulation
corpus remain on the orthodox compatibility session. No variant game is
silently mislabeled as standard training data.
