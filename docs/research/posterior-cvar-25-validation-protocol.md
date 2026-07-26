# Posterior CVaR-25 validation protocol

Status: preregistered; candidate outcomes not read

## Question

Can lower-tail posterior risk use public drawback probabilities without the
catastrophic optimism observed in `posterior-expected`, while choosing moves
that are measurably better than the production `worst-case` policy?

The candidate is `posterior-cvar-25`. At every opponent node it:

1. finds the opponent's minimum-score reply separately in every surviving
   exact-rule world;
2. sorts those world outcomes from worst to best for the root player;
3. integrates exactly the worst 25% of normalized posterior mass, including a
   fractional boundary world when necessary; and
4. returns the lower-tail mean.

Start-of-turn loss and empty-mask worlds remain explicit terminal outcomes.
Observed replies still hard-condition the child posterior. The explanatory
principal variation follows the lowest-scoring reply represented in the
included tail. The 25% tail is versioned in the policy ID and is not tuned
after validation.

## Frozen source and corpus

- parent Engine revision:
  `74eb6fc95571994bd96b7a351278f3f74f0972e3`;
- corpus:
  `capturable25-v3-balanced-validation-trace.ndjson`;
- corpus SHA-256:
  `788fa649011d114c5bbe2937ab8c98d2ae3c1a7b57c1ba18b85b5fac23802967`;
- corpus records: 625 authenticated player-private games;
- hypothesis policy: audited uniform over the 25 capturable labels with exact
  public-replay elimination;
- evaluator: drawback material v1;
- outer depth: 2;
- node budget: 10,000 per search;
- candidate and oracle use identical depth, node budget, position, own
  drawback, and public opponent hypotheses.

The benchmark parser must validate every privileged trace through exact
semantic replay before using it. The exact hidden-rule search is used only as
the post-selection oracle scorer. Neither player-private candidate receives
the true opponent drawback.

## Selection positions

The selection gate contains 60 current-catalog positions:

- games 0 through 29 at target ply 1, with Black to move;
- games 0 through 29 at target ply 2, with White to move.

The frozen commands are:

```bash
pnpm benchmark:posterior \
  ../DrawbackTrainingData/capturable25-v3-balanced-validation-trace.ndjson \
  0 30 1 2 10000

pnpm benchmark:posterior \
  ../DrawbackTrainingData/capturable25-v3-balanced-validation-trace.ndjson \
  0 30 2 2 10000
```

Before candidate output was read, the monolithic execution was found to be
too slow to use available CPU cores: the second cohort took several minutes
for its first position. Either command may therefore be executed as six
contiguous five-game shards with starts `0`, `5`, `10`, `15`, `20`, and `25`.
The union, order, policies, depth, budget, and oracle calculations are
unchanged. The committed shard combiner must reject a gap, duplicate,
parameter mismatch, malformed record, or inconsistent per-shard summary and
must reproduce one ordered 30-position report. Operational parallelism is not
a model or gate change.

The benchmark reports production `worst-case`, rejected
`posterior-expected`, and candidate `posterior-cvar-25`. Oracle scoring is
memoized only when policies choose the same root move; this cannot change an
oracle score.

## Selection gate

All requirements are conjunctive:

1. all 60 positions and every policy/oracle search complete without
   truncation;
2. the candidate differs from `worst-case` on at least one position;
3. on every changed position, the exact hidden-rule oracle never scores the
   candidate below `worst-case`;
4. the candidate has at least one strict oracle win;
5. candidate-minus-`worst-case` mean oracle score is positive over all 60
   positions;
6. neither color cohort has a negative mean oracle delta;
7. deterministic unit tests prove fractional tail integration, terminal-world
   treatment, catastrophic-risk rejection, principal-variation semantics,
   iterative-search propagation, worker protocol validation, and trace
   provenance.

A neutral result fails requirements 2, 4, or 5. A single oracle loss fails
requirement 3 regardless of average gain. `posterior-expected` is a reference
arm and cannot be promoted by this protocol.

## Confirmation rule

Only if the selection gate passes may the same frozen comparison be run on
games 100 through 129 at plies 1 and 2. The confirmation slice must satisfy
the same seven requirements independently. The production profile remains
`worst-case` unless both stages pass.

If selection fails, the confirmation slice is not opened. The candidate may
remain an explicitly experimental research mode if its implementation and
tests pass, but it must not be called stronger or made the default.

This protocol does not use, generate, or authorize opening a neural-model
sealed test split.
