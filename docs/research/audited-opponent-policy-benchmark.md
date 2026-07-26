# Audited opponent policy benchmark

## Question

Does replacing the unrestricted opponent control with a public-only uniform
posterior over the ten audited drawbacks improve move selection under the
current player-private search?

This is a historical ten-label snapshot. The active player-private catalog was
later expanded to 25 labels; these results must not be reported as evidence
for the expanded catalog.

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

## First-stage decision

The policy is accepted as exact symbolic-elimination infrastructure, not as a
demonstrated playing-strength improvement. The neutral result is expected from
the current worst-case reply union: one surviving permissive hypothesis can
retain an opponent move even when most posterior mass forbids it.

The next search milestone is an explicit probability-aware aggregation mode.
It must preserve worst-case as a configurable safety control, bind the chosen
mode into trace provenance, and be evaluated on fresh validation positions
before becoming a default.

## Posterior-expected promotion gate

The next implementation added an explicit `posterior-expected` mode. At every
opponent node, each surviving hypothesis independently selects its
lowest-valued legal reply. The node score is the posterior-weighted mean of
those world-specific minima. A world in which the opponent has already lost
at the start of turn, or has an empty exact legal mask, contributes a terminal
root win instead of being dropped. Observable reply branches still condition
the child posterior by hard legality, so eliminated hypotheses cannot return.

The comparison is reproducible with:

```bash
pnpm benchmark:posterior -- \
  ../DrawbackTrainingData/capturable-v2-validation-100.ndjson \
  30 30 8 2 10000
```

This used games 30 through 59 at ply eight, which are different public
positions from the earlier ply-six sample. It compared `worst-case` and
`posterior-expected` over the same audited posterior, then scored both selected
moves with the true hidden-rule omniscient search at identical depth and node
limits. All 30 positions were White to move because the sampled ply was even;
that narrow coverage is sufficient to reject a losing promotion candidate,
not to estimate overall playing strength. The sealed final test corpus was not
used.

Result:

- complete positions: 30/30;
- truncated positions: 0;
- surviving posterior particles: 8 to 11;
- different selected moves: 1/30;
- posterior-expected oracle wins: 0;
- worst-case oracle wins: 1;
- equal oracle scores on changed moves: 0;
- mean posterior-expected-minus-worst-case oracle score: -10.67 centipawns.

On game 45, `worst-case` chose `a2a3`, while `posterior-expected` chose
`b5c7`. The exact true-rule oracle scored them at +100 and -220 centipawns,
respectively. The 320-centipawn loss came from treating probability mass on
opponent start-of-turn-loss worlds as expected reward even though the true
world was not one of those terminal cases.

## Current decision

The probability-aware implementation is accepted as a tested experimental
search mode, but it is rejected as the production profile default.
`audited-opponent-v1` explicitly remains `worst-case`.

The next strength experiment should be risk-sensitive rather than a raw mean:
for example, a configurable lower-tail/CVaR score or a worst-case safety floor
with posterior expectation used only as a tie-break. It must use this same
fresh-position true-rule oracle gate and must not be promoted on a neutral or
negative result.
