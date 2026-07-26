# Audited opponent policy benchmark

## Question

Does replacing the unrestricted opponent control with a public-only uniform
posterior over the ten audited drawbacks improve move selection under the
current player-private search?

## Frozen implementation

The `audited-uniform/v1` provider:

- starts with equal probability per audited drawback label;
- splits Triple Play's label mass between its bishop and knight particles;
- reconstructs every particle only from the authenticated public replay;
- eliminates particles that had already lost or forbid an observed move;
- renormalizes surviving mass;
- aborts on authority or final-position replay divergence;
- never receives the true opponent drawback, parameters, state, or game seed.

The player-private search still uses its existing `worst-case` aggregation.
Probabilities therefore affect posterior state but do not directly weight
opponent replies.

## Terminal diagnostic matches

Ten fixed assignments were played twice from the public king-capture
diagnostic scenarios. The audited policy and unrestricted control swapped
colors while hidden labels, hidden-parameter seeds, gameplay seeds, search
depth, node budget, evaluator, and temperature remained fixed.

Configuration:

- 20 games;
- search depth 2;
- 5,000 node budget;
- top-1 move selection;
- eight-ply game limit;
- drawback material leaf evaluator.

Result:

- audited score: 10.0/20;
- unrestricted score: 10.0/20;
- 18 king-capture endings;
- 2 active games at the ply limit;
- average 2.3 plies.

This corpus was too dominated by immediate terminal captures to distinguish
the policies. It is a terminal-regression check, not evidence of equal general
strength.

## Validation-position oracle comparison

Thirty public positions were sampled at ply six, one per game, from
`capturable-v2-validation-100.ndjson`. The final sealed test corpus was not
used. Both policies searched every position at depth 2 with a 10,000-node
budget. Each selected move was then scored at the same depth and node budget
by the omniscient exact-rule search using the true hidden runtimes and the
drawback material evaluator. No search truncated.

Result:

- positions: 30;
- audited posterior particles after exact pruning: 8 to 11;
- different selected moves: 0/30;
- audited oracle wins: 0;
- unrestricted oracle wins: 0;
- equal oracle scores: 30;
- mean audited-minus-unrestricted oracle score: 0 centipawns.

## Decision

The policy is accepted as exact symbolic-elimination infrastructure, not as a
demonstrated playing-strength improvement. The neutral result is expected from
the current worst-case reply union: one surviving permissive hypothesis can
retain an opponent move even when most posterior mass forbids it.

The next search milestone is an explicit probability-aware aggregation mode.
It must preserve worst-case as a configurable safety control, bind the chosen
mode into trace provenance, and be evaluated on fresh validation positions
before becoming a default.
