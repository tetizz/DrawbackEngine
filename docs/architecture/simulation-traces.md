# Private simulation trace contract

DrawbackEngine exports completed simulations as
`drawbackengine-private-simulation-trace` schema version 1. Each NDJSON line is
one complete game with a deterministic game ID derived from its unsigned
32-bit seed and split-global game index. The record also binds the configured
ply limit and whether public evaluator facts are absent or uniformly present.

This is a privileged interchange format, not a player observation or a model
input. It contains the true rule, hidden parameters, and pre-move internal
state for the active player on every ply. Files must remain in trusted local
storage. DrawbackGuesser is responsible for reconstructing public features
first and attaching these fields only afterward as training labels.

## Authority and compatibility

Version 1 explicitly identifies `standard-chess/v1`. It represents the
`chess.js` simulation kernel, including ordinary check legality and standard
ending rules. It must not be used to describe capturable-king games. A future
authority requires a new reviewed trace contract rather than reinterpreting
version 1.

The wire format uses UCI strings for legal masks and `{ uci, san }` for the
observed move. This prevents private TypeScript move-object details from
becoming a cross-repository API. Result objects retain the tagged
`SessionResult` representation.

## Validation

The runtime parser fails closed on:

- unknown or missing keys and unsupported format versions;
- seeds outside the unsigned 32-bit domain or inconsistent game IDs;
- non-contiguous initial, ply, and final FENs;
- an incomplete ordinary legal mask, forged SAN, illegal move, or impossible
  FEN transition under `standard-chess/v1`;
- a ply color that disagrees with the FEN side to move;
- malformed, duplicate, or inconsistent ordinary and drawback move masks;
- observed moves outside the exact drawback-legal mask;
- incorrect `ruleTriggered` or `forced` flags;
- a pre-move label that disagrees with the post-game reveal;
- evaluator facts with malformed digests or non-legal best moves;
- mixed evaluator coverage, stale evaluator position keys, or multiple
  evaluator policies/fingerprints in one game;
- active results that did not reach the recorded ply limit and terminal
  results incorrectly marked as limit-stopped;
- non-finite values, functions, classes, or excessive nesting in secret data.

The simulation projection passes its own output through this parser. Invalid
state therefore stops generation before a trace can be published.

## Publication and sharding

The batch CLIs write to a same-directory temporary file, honor stream
backpressure, calculate the exact UTF-8 SHA-256 digest, and publish with a
no-clobber hard link only after the stream is complete. Existing files are
never replaced. Private files are created with owner-only `0600` permissions
on POSIX systems, and cleanup failures are reported instead of silently
leaving temporary secret data behind.

`gameIndexOffset` makes ordered shard output byte-identical to one monolithic
export. Worker-count determinism remains a simulation invariant; the trace
writer preserves the supplied game order.

## Dependency direction

```text
simulation-arena -> simulation-trace
                         |
                         v
             DrawbackGuesser trace adapter
                         |
                         v
                  training rows
```

DrawbackEngine never imports predictor, dataset, or machine-learning code.
DrawbackGuesser may pin and parse this small wire-contract package without
importing the simulation implementation.
