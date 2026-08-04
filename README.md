# DrawbackEngine

DrawbackEngine is a TypeScript engine for chess games where each player has a
separate hidden rule that restricts their legal moves or adds a loss condition.
It combines ordinary chess legality, exact drawback enforcement, variant-aware
position authority, search, UCI evaluation, and deterministic self-play.

The engine is intended for local games, testing, simulation, and post-game
research. It is not built for covert assistance during competitive games on
other websites.

## What is included

- standard chess legality through `chess.js`;
- a capturable-king position authority for rules that require literal king
  capture;
- 180 synchronous rules and 182 prepared rules, including evaluator-backed
  turn constraints;
- immutable drawback move filtering and start-of-turn loss checks;
- exact outer search with player-private and omniscient entry points;
- Stockfish and Fairy-Stockfish leaf evaluation through UCI;
- deterministic random, material, human-like, temperature, and Stockfish
  self-play agents;
- worker-thread batch simulation;
- machine-readable catalogs, replay fixtures, rule specifications, and
  verification evidence.

Stockfish and Fairy-Stockfish are optional external programs. Their binaries
are not included.

## Repository layout

```text
apps/
  engine-cli/             local demos, exact move search, and PGN sidecars
  play-web/               local human-vs-engine browser game
packages/
  shared/                 colors and deterministic random sources
  drawback-engine/        rule contracts, rules, filters, and losses
  chess-core/             position authorities and game sessions
  probe-search/           information-gain search primitives
  drawback-search/        drawback-aware search and diagnostics
  chess-evaluator/        UCI clients, transports, and leaf evaluators
  simulation-arena/       deterministic agents, batches, and worker threads
data/
  catalog/                rule metadata and Fairy-Stockfish configuration
  fixtures/               replay fixtures
docs/
  architecture/           engine contracts and decision ownership
  rules/                  rule specifications and ambiguities
  research/               source and validation notes
```

The engine owns legality and termination. UCI engines evaluate positions only
after the exact outer engine has generated and filtered the legal move set.
Neither a UCI result nor a downstream model may restore a forbidden move.

## Requirements

- Node.js 22 or newer
- pnpm 11.9.0

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Run the full local gate:

```bash
pnpm check
```

The gate performs strict type checking, linting, catalog evidence validation,
repository-boundary checks, production builds, the complete test suite, and
built-package import smokes.

Focused commands:

```bash
pnpm test:rules
pnpm test:search
pnpm test:arena
pnpm catalog:verify-evidence
```

## Play against the engine

Build and launch the local browser board with an authenticated Fairy-Stockfish
configuration:

```bash
pnpm play:web -- --evaluator-config C:\trusted\fairy-stockfish.json
```

Open the printed `http://127.0.0.1:4173` address. The app supports full games,
click or drag moves, promotion, board flipping, legal-target highlighting,
resignation, a post-game drawback reveal, and responsive keyboard-accessible
controls.

This browser surface currently offers the frozen audited 25-rule
player-private catalog. It does not claim support for every authority-compatible
or observed drawback in interactive player-private search.

The Quick, Balanced, and Deep choices are exact outer-search budgets, not Elo
claims. Their configured depth and node cap remain visible during the game;
the configured Fairy-Stockfish leaf depth, Hash, thread count, and fixed skill
setting are shown separately. Every computer move calls the player-private
drawback search and authenticated evaluator. There are no scripted moves or
material-evaluator fallbacks.

Browser play binds only to IPv4 loopback, requires same-origin state changes,
and never sends FEN, SAN, captured-piece metadata, search scores, completed
work counters, opponent hypotheses, hidden state, or local paths to the page.
Only the player's own drawback is visible before the game ends. See
[`docs/architecture/local-play-web.md`](docs/architecture/local-play-web.md)
for the security and lifecycle contract. The evaluator JSON format is the
Fairy-Stockfish form documented in
[`docs/architecture/player-private-uci-workers.md`](docs/architecture/player-private-uci-workers.md).

## CLI

Run a deterministic hidden-drawback game:

```bash
pnpm --filter @drawbackengine/cli demo
```

Run a parallel batch:

```bash
pnpm --filter @drawbackengine/cli parallel -- 100 8
```

Orthodox batch commands write one complete privileged simulation trace per NDJSON line
and refuse to overwrite an existing file. These traces contain post-game
labels and secret rule state, so they belong in trusted local storage and are
never model inputs by themselves. DrawbackGuesser owns the separate,
leakage-checked per-move training schema; a release corpus must pass that
consumer contract before training. The exact versioned format and trust
boundary are documented in
[`docs/architecture/simulation-traces.md`](docs/architecture/simulation-traces.md).

Player-private capturable-king simulations have a separate versioned trace
contract with full public authority snapshots and exact executable replay.
They are not written through the orthodox batch command. Generate one
explicit split at a time with the same split counts and seed roots:

```bash
pnpm --filter @drawbackengine/cli player-private:batch -- \
  train 1000 200 200 8 448663553 1785536514 2586451971 \
  data/player-private-train.ndjson
```

The positional values are split, train/validation/test counts, workers,
label/gameplay/parameter seed roots, and output path. Optional trailing values
set max plies, bounded window size, search depth, node budget, temperature,
and a named training profile. The default profile is `standard`.
Use `validation` and `test` with otherwise identical arguments to publish the
held-out files. The scheduler balances ordered drawback pairs independently
inside each split, keeps their gameplay seeds disjoint, and streams without
materializing the corpus in RAM. DrawbackGuesser must convert and validate
these privileged traces before model training.

For the frozen DrawbackGuesser Schema 9 schedule, use the receipt-producing
bundle command instead of the positional batch command:

```bash
pnpm --filter @drawbackengine/cli player-private:schema9 -- \
  --ledger-split train \
  --games 25 \
  --workers 4 \
  --schedule-id schema9-smoke-v1 \
  --bundle /trusted/private/schema9/train \
  --engine-repository /absolute/path/to/DrawbackEngine
```

Run the same command separately for `validation-a`, `validation-b`, and
`test`. Each final directory contains `trace.ndjson`, `launch.json`, and
`completion.json`. The command accepts only a clean executing Engine checkout,
refuses output inside that checkout, authenticates the completed trace bytes,
and atomically publishes without clobbering an existing bundle. Create the
trusted output parent first; symlinked or junction parents are canonicalized
and cannot redirect private output into the checkout. See
[`docs/architecture/schema9-player-private-bundles.md`](docs/architecture/schema9-player-private-bundles.md)
for the frozen schedule, receipt contract, and interruption behavior.

The final two optional values select the leaf evaluator and its private
configuration. `material` remains the default. `node-uci-leaf` starts one
authenticated, caller-depth Stockfish or Fairy-Stockfish leaf process per
parent-owned simulation slot:

```bash
pnpm --filter @drawbackengine/cli player-private:batch -- \
  train 1000 200 200 8 448663553 1785536514 2586451971 \
  /trusted/output/player-private-train.ndjson \
  120 32 2 50000 35 standard node-uci-leaf \
  /trusted/config/stockfish.json
```

The configuration and binaries stay outside the repository. The executable
bytes, UCI identity, advertised options, fixed strength-related UCI settings,
and search depth are authenticated before use; there is no silent material
fallback. Progress and completion are emitted as path-free JSON. See
[`docs/architecture/player-private-uci-workers.md`](docs/architecture/player-private-uci-workers.md)
for the exact schema, lifecycle, and fail-closed limitations.

The `king-capture-diagnostics-v1` profile restricts labels to the five audited
king-capture drawbacks and starts from eight public, symmetric diagnostic
positions:

```bash
pnpm --filter @drawbackengine/cli player-private:batch -- \
  train 500 100 100 8 286331153 572662306 858993459 \
  ../DrawbackTrainingData/king-diagnostics-train.ndjson \
  4 32 1 5000 35 king-capture-diagnostics-v1
```

It creates queen/non-queen king-capture choices, promotion unlocks, three-piece
thresholds, and next-check obligations. Starting positions are selected only
from the gameplay seed domain; hidden labels and parameter seeds cannot affect
them. Use separate seed roots for selection or test corpora.

Use `catalog-balanced-king-diagnostics-v1` with the same command to schedule
all 25 audited labels over those eight positions. This supplies non-target
hard negatives and keeps every label/color marginal and ordered pair balanced;
it is the preferred profile when a five-rule diagnostic supplement would
otherwise change the learned class prior.

Use `audited-opponent-v1` to make both private search agents reason against all
publicly surviving audited drawbacks instead of the unrestricted control:

```bash
pnpm --filter @drawbackengine/cli player-private:batch -- \
  train 100 20 20 8 448663553 1785536514 2586451971 \
  ../DrawbackTrainingData/audited-opponent-train.ndjson \
  120 32 2 50000 35 audited-opponent-v1
```

This model starts with equal mass per audited drawback label, reconstructs
state from public moves, eliminates impossible hypotheses exactly, and never
reads the opponent's true rule, parameters, or state. It deliberately retains
the `worst-case` aggregation safety policy. The separate
`posterior-expected` research mode is available through the search and worker
APIs, but it was not promoted after its first held-out validation comparison
lost 320 centipawns on the only position where it changed the selected move.
`posterior-cvar-25` is a second experimental mode that averages only the
worst posterior quartile. It passed its correctness and completion checks but
changed no move in its frozen 60-position selection benchmark, so the
preregistered gate rejected it as neutral. The production profile remains
`worst-case`.

Ask the exact drawback-aware search for a move:

```bash
pnpm --filter @drawbackengine/cli oracle:move -- \
  --fen "<fen>" \
  --stockfish "/absolute/path/to/stockfish" \
  --stockfish-sha256 "<expected 64-character digest>"
```

The current oracle command demonstrates a Vegan-versus-Checkers game and
prints its fixed knowledge mode. It refuses to run unless the supplied engine
binary matches the expected SHA-256 digest. It is a local demonstration CLI,
not the authenticated simulation runner: it does not stage a private executable
copy or pin the engine's advertised UCI option surface. Run it only from a
trusted path that cannot change after verification. Use `player-private:batch`
with `node-uci-leaf` for authenticated, long-running simulation work.

Use `--engine-kind fairy-stockfish` together with an absolute path to the
repository's `data/catalog/drawbackchess-fairy-v1.ini` file for the optional
Fairy leaf evaluator. Filtered pnpm commands run from the CLI package directory,
so a repository-root-relative `data/catalog/...` path will not resolve there.
The adapter authenticates the exact variant bytes before use.

## Rule status

Rule metadata uses four conservative statuses:

- `verified`
- `implemented-unverified`
- `partial`
- `unsupported`

A working implementation is not automatically called verified. The evidence
gate checks specifications, positive and negative behavior, edge cases, and
replay fixtures. Ambiguous behavior remains documented rather than silently
presented as authoritative.

## Determinism

All random choices use injected random sources. Simulations derive separate
streams for each side's hidden parameters and for each player at each ply, so
one rule or agent cannot shift another stream by consuming extra random values.
Fixed seeds preserve assignments, parameters, agent choices, and results.
Catalog order is part of the reproducibility contract.

## License

Original project source is available under the MIT License. Dependencies,
external engines, rule names, and community research retain their own terms.
See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
