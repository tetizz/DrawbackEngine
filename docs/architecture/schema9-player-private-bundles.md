# Schema 9 player-private bundles

DrawbackGuesser Schema 9 consumes four isolated Engine schedules: `train`,
`validation-a`, `validation-b`, and `test`. The Engine exposes one narrow
producer command for this handoff. It does not accept arbitrary seeds,
profiles, evaluators, or search settings.

## Invocation

Run from a clean Engine checkout and place every bundle outside the checkout:

```bash
pnpm --filter @drawbackengine/cli player-private:schema9 -- \
  --ledger-split train \
  --games 25 \
  --workers 4 \
  --schedule-id schema9-smoke-v1 \
  --bundle /trusted/private/schema9/train \
  --engine-repository /absolute/path/to/DrawbackEngine
```

The bundle's parent directory must already exist. The producer canonicalizes
that parent before creating anything and rejects a symlink or junction that
resolves into the Engine checkout.

All six named flags are mandatory and may appear only once. `--games` must be
a positive multiple of 25 and no greater than the unsigned 32-bit range.
`--workers` is limited to 1 through 256. A 25-game split is the minimum
pipeline smoke; it is not an accuracy benchmark. A destination that already
exists is never replaced.

The repository argument must resolve to the checkout executing the command.
Generation fails if the checkout has tracked or untracked changes, replace
refs, or hidden index flags such as `assume-unchanged`. The full lowercase
commit is copied into both receipts. The same clean commit is checked again
after trace authentication and immediately before publication. This detects
ordinary worktree drift during a long run. It is not a signature or a defense
against a hostile same-owner process that changes files transiently and then
restores them, so corpus production still requires a trusted local machine and
trusted Git object storage.

## Frozen schedule

Each ledger split uses an isolated Engine `train` schedule with validation and
test counts set to zero. The three roots are label, gameplay, and parameter
roots in that order:

| Ledger split | Seed roots |
| --- | --- |
| `train` | `1261462769`, `242269024`, `1837697911` |
| `validation-a` | `2069246597`, `1391196133`, `2739675947` |
| `validation-b` | `3786384219`, `3547865132`, `2689552677` |
| `test` | `2033321041`, `1354035545`, `4189758462` |

Receipt version 2 pins all corpus-semantic generation settings:

```json
{
  "maxPlies": 120,
  "maxDepth": 2,
  "maxNodes": 50000,
  "temperatureCp": 35,
  "topK": 8,
  "leafCacheEntries": 16384,
  "leafCacheHistoryMode": "full",
  "opponentAggregation": "worst-case",
  "evaluator": {
    "kind": "material",
    "version": 1,
    "evaluatorId": "drawback-material/v1"
  },
  "opponentHypotheses": {
    "kind": "unrestricted-baseline",
    "version": 1
  }
}
```

Worker count and streaming window size do not change assignment or move
selection and are deliberately excluded from this semantic configuration.
Determinism tests must continue to cover worker-count independence.

## Publication and receipts

Generation starts in a same-parent private temporary directory. A successful
bundle is published by a directory rename and contains exactly:

- `trace.ndjson`: privileged Engine games for one ledger split;
- `launch.json`: schedule authority, split, roots, profile, fixed generation
  configuration, and producer commit;
- `completion.json`: launch-receipt SHA-256 and the re-read trace SHA-256,
  byte count, game count, and contiguous index bounds.

The producer re-opens and hashes `trace.ndjson` after the batch writer closes
it. A mismatch between those bytes and the writer result fails closed. The
completion receipt is therefore bound to the file actually published, not to
an in-memory claim from the simulator.

On generation failure or cancellation before the final rename, the producer
removes its unpublished temporary directory. Cleanup and every retained retry
verify the temporary directory's filesystem identity before recursive removal,
so a replacement path is never deleted. The final rename is the irreversible
commit point: after it succeeds, the complete authenticated bundle remains
published. Cleanup failures remain explicit retained-cleanup errors for the
CLI retry path; they are never converted into a successful completion event.

Progress output is throttled and each JSON line waits for stream backpressure.
A broken output pipe before the commit point aborts generation and follows the
same cleanup path. SIGINT and SIGTERM use cooperative cancellation through the
writer, final trace hash, simulation workers, and bundle owner.

These files contain labels and private rule state. Keep them in trusted local
storage, do not commit them, and pass them only to DrawbackGuesser's
leakage-checked converter and ledger verifier.
