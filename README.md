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

## CLI

Run a deterministic hidden-drawback game:

```bash
pnpm --filter @drawbackengine/cli demo
```

Run a parallel batch:

```bash
pnpm --filter @drawbackengine/cli parallel -- 100 8
```

Batch commands write one complete privileged simulation trace per NDJSON line
and refuse to overwrite an existing file. These traces contain post-game
labels and secret rule state, so they belong in trusted local storage and are
never model inputs by themselves. DrawbackGuesser owns the separate,
leakage-checked per-move training schema; a release corpus must pass that
consumer contract before training. The exact versioned format and trust
boundary are documented in
[`docs/architecture/simulation-traces.md`](docs/architecture/simulation-traces.md).

Ask the exact drawback-aware search for a move:

```bash
pnpm --filter @drawbackengine/cli oracle:move -- \
  --fen "<fen>" \
  --stockfish "/absolute/path/to/stockfish" \
  --stockfish-sha256 "<expected 64-character digest>"
```

The current oracle command demonstrates a Vegan-versus-Checkers game and
prints its fixed knowledge mode. It refuses to run unless the supplied engine
binary matches the expected SHA-256 digest.

Use `--engine-kind fairy-stockfish` together with
`--variant-path data/catalog/drawbackchess-fairy-v1.ini` for the optional Fairy
leaf evaluator. The adapter authenticates the exact variant bytes before use.

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
