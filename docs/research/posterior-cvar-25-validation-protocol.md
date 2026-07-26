# Posterior CVaR-25 validation protocol

Status: selection complete; candidate rejected as neutral

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

After the six shard JSON files for one ply have completed, combine them with:

```bash
pnpm benchmark:posterior:combine \
  ../DrawbackTrainingData/capturable25-v3-balanced-validation-trace.ndjson \
  0 30 <ply> 2 10000 \
  <start-0.json> <start-5.json> <start-10.json> \
  <start-15.json> <start-20.json> <start-25.json>
```

The combiner parses a closed report schema, recalculates complete/truncated
counts and both policy summaries from individual comparisons, requires every
game index exactly once, and prints the SHA-256 of every source shard.

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

## Selection outcome

All twelve five-game shard reports passed strict parsing and summary
recalculation. Both combined cohorts completed all 30 positions without
truncation.

| Cohort | Candidate move changes | Candidate oracle wins | Worst-case oracle wins | Mean candidate delta |
| --- | ---: | ---: | ---: | ---: |
| Black to move, ply 1 | 0 | 0 | 0 | 0 cp |
| White to move, ply 2 | 0 | 0 | 0 | 0 cp |
| Combined | 0 | 0 | 0 | 0 cp |

`posterior-expected` also changed no move. It produced different internal
search scores on two positions, including one 39,995.96-centipawn increase,
without changing the selected root. CVaR differed from worst-case only by
binary64 round-off of at most approximately `1.42e-14` centipawns on two
positions. Every position retained 26 parameter particles.

The combined content hashes are:

- Black/ply-1 report:
  `8de8e238d3a48fde8d0f10ec5ab5aa7d80a5dbc3f01b2a10bf441339340bf922`;
- White/ply-2 report:
  `e39bca1a1d7ddc9b9e293e49040e7b174b8deb2d3bc93141b8ec56299e2e817e`.

The source shard hashes, ordered by ply and start index, are:

```text
ply1 start 0   a0b32f90702b5361b3af041bc82aec07f57cba5637c8ca598f8514b4f85e086d
ply1 start 5   b7aae5a94310f85fe40efec335ff11498f2de4c7c1cb35c82a95a76e6c1a844e
ply1 start 10  ac0ad017c0f6db3f0447d73591905f192bd85cc8fe5300ec15435fa5caf0c8c0
ply1 start 15  75fabbab2201b85b367231dcf07fd0e3f53fc3909014936fcc372bb2099699ea
ply1 start 20  e7545f37a9e3d1a17377ffd84af4fc806bd9652b80ae9b0796f440632fbdc401
ply1 start 25  8cf71c4cfcdf687b510046582270776a9c9102f376f82079e6e136d75b88906c
ply2 start 0   e2443e4d1a5292c66f45986500298ccf09e9216c73fd0433c9b40ddc08e66368
ply2 start 5   ade1e43d15f25d947605eca86b6c14315b2c194622d283bb675dc5ddb498f5bc
ply2 start 10  d237eff18dbff2b4e18a1f7cd2c6e2088460bc3f9fbdb4976dedfe382482550c
ply2 start 15  c63e807ac93eee0aeecf3607ed524383ef73b201754ece21b6e361233a776ff6
ply2 start 20  bddb7f3807ee68057d59183d5f6e6652612745ea8ee6939a10480cadaec0773b
ply2 start 25  f24139a56582aaf2365d0c0dc207447109ae5cf44bef6615f00e48377f6a7f66
```

Requirement 1 passed. Requirements 3 and 6 had no regression, and the
implementation evidence for requirement 7 passed. Requirements 2, 4, and 5
failed because the result was neutral. Under the frozen conjunctive gate, the
candidate is rejected for production and the confirmation slice remains
unopened. `posterior-cvar-25` stays available only as an explicitly selected
research mode; `audited-opponent-v1` remains `worst-case`.
