# Observed drawback catalog

Last imported: 2026-07-24

`data/catalog/observed-drawbacks.json` is the master discovery catalog. It
currently contains 194 unique names and descriptions:

- 182 executable: 181 `implemented-unverified` and one `partial`
- 12 `unsupported`

The public sources are:

- the player-compiled glossary in replies 5 and 13 of the Chess.com forum
  thread [“all drawbacks”](https://www.chess.com/forum/view/general/all-drawbacks);
- the [InvalidSE/DrawbackDetector](https://github.com/InvalidSE/DrawbackDetector)
  observation corpus, which contains 819 Selenium-collected drawback
observations from DrawbackChess games.

The latest executable waves add board-relative and geometric restrictions,
history-driven and stateful restrictions, deadline losses, evaluator-backed
turn constraints, and exact
hidden-parameter families. The
predictor enumerates all 20 currently supported variants of Crenellations,
Theocracy, Active Volcano, and Comfort Zone rather than sampling them. The
eight-square domain used for the latter two is inferred from the observation
corpus and remains explicitly unverified.

Colorblind, Hand and Brainless, Obsession, and Winds of Fate use a deterministic
secret seed in executable games so simulations replay exactly. Prediction does
not attempt to recover that seed: it exactly marginalizes all possible current
turn outcomes (2, 6, 64, and 2 respectively), preventing a finite particle
sample from falsely eliminating a compatible rerandomized rule.

The tenth executable wave adds Expedition, Reflective, Eye of Sauron, Drag,
and Ooh Shiny. These rules cover a fixed deadline, reflected-square occupancy,
a rook-defined advancement frontier, original-piece tracking with a loss
condition, and legal-recapture-aware forced captures.

The eleventh executable wave adds Bridge Over Troubled Water and
Reconnaissance. These cover explicit board terrain and persistent,
one-turn-delayed capture-type learning. Their terrain geometry, unlock timing,
and arbitrary-midgame reconstruction limitation are recorded in the rule
specification rather than presented as verified official behavior.

These are community and observational evidence, not an official Drawback Chess
specification. The detector corpus contributes 15 titles absent from the forum
glossary and corroborates the exact wording “Your bishops can't capture” for
False Prophets. Its counts describe the collected sample only; they must not be
treated as unbiased global drawback frequencies.

## Import behavior

Run:

```text
pnpm catalog:import-observed
```

The importer:

1. fetches the two attributable glossary posts and detector observation corpus;
2. extracts and validates name/description pairs;
3. groups detector observations and retains observed counts and wording samples;
4. normalizes stable IDs and known spelling aliases;
5. merges the repository's reviewed catalog fragments;
6. leaves every unreviewed entry `unsupported`;
7. refuses to write a suspiciously small result.

The committed snapshot is used by tests; CI never depends on live network
access. A refresh changes the snapshot only when run explicitly.

## Status policy

Catalog presence does not imply executable support. A rule becomes
`implemented-unverified` only after it has:

- a written interpretation and ambiguity record;
- an implementation through the common rule contract;
- positive and negative tests;
- relevant special-move and loss-condition tests;
- a replay fixture;
- predictor and simulator registration.

Only official text or reproducible original-site observations can support a
future `verified` status.
