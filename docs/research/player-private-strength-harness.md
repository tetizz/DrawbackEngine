# Player-private strength harness

The strength harness compares two named search policies in deterministic,
color-swapped game pairs. It reports game score, not Elo. A result is evidence
about the exact benchmark configuration only; it is not a general claim that
either participant is strong.

## Pairing and privacy

Each pair uses the same initial FEN, public game seed, hidden drawback IDs, and
independent White and Black parameter seeds in both legs. The candidate plays
White once and Black once. Pair execution order alternates to reduce systematic
order effects.

Search runs through the player-private simulation boundary. A participant sees
its own executable drawback capability, public history, and public opponent
hypotheses. It does not receive the opponent's hidden drawback, parameters, or
internal state. The harness checks internally that both legs used the same
initial secret assignment, but emits neither that assignment nor a reversible
fingerprint of it. It also omits parameter seeds, drawback-loss rule IDs, and
private loss reasons. Public outcome classifications, final positions, and
public move-trace digests remain in the report.

## Outcomes and uncertainty

The report includes exact wins, draws, losses, decisive games, and ply-limit
games. A game stopped at the ply limit is censored and is never converted to a
draw. Consequently the report includes exact lower and upper score bounds for
all scheduled games.

For completed pairs, paired delta is candidate score minus 0.5. The uncertainty
interval widens the exact censoring bounds by the two-sided Hoeffding radius

```text
sqrt(log(2 / alpha) / (2 * pair_count))
```

and clamps the result to `[-0.5, 0.5]`. This sampling interval assumes benchmark
pairs are independent observations from the population being estimated. The
censoring bounds themselves need no distributional assumption.

## Evaluator identity

Every participant records both a search-policy snapshot and an evaluator ID.
Material evaluation must identify as `drawback-material/v1`. Fairy-Stockfish
must use the authenticated `node-uci-leaf/v1/<sha256>` identity produced from a
pinned executable and runtime context. Orthodox Stockfish is rejected because
it does not implement the capturable-king drawback semantics used here.
The CLI obtains Fairy evaluator IDs from the authenticated process factory. A
direct library caller supplies its own evaluator object and is responsible for
establishing that the implementation behind its reported ID is trustworthy.

## Running a match

Run a small material-evaluator comparison from the repository root:

```powershell
pnpm arena:strength 20 candidate 2 256 baseline 1 64 300
```

The optional positional arguments after `max-plies` are label, gameplay, and
parameter seeds, followed by candidate evaluator mode/config and baseline
evaluator mode/config. Use `-` as the config placeholder for a material
participant when later evaluator arguments are present. For an authenticated
Fairy-Stockfish comparison:

```powershell
pnpm arena:strength 20 candidate 2 256 baseline 1 64 300 1369952257 1369952258 1369952259 fairy-stockfish .\candidate-evaluator.json fairy-stockfish .\baseline-evaluator.json
```

For a material candidate against a Fairy-Stockfish baseline, the tail is:

```powershell
material - fairy-stockfish .\baseline-evaluator.json
```

`SIGINT` and `SIGTERM` cancel evaluator startup or search, then close every
evaluator that was successfully opened before the process exits.

Before promoting a policy, use a preregistered held-out seed range, identical
evaluator configuration for both participants, enough completed pairs for the
paired uncertainty interval to exclude zero, and a second untouched seed range
for confirmation. Do not impute ply-limit games or convert this interval into
an Elo estimate.

## Feasibility smoke

A two-leg, 12-ply material smoke replayed identically. Both legs reached the
ply limit, so it proves deterministic execution only and contains no strength
result.
