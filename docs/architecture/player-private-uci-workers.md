# Authenticated UCI player-private workers

The player-private corpus runner can use a caller-supplied Stockfish or
Fairy-Stockfish executable as a leaf evaluator. DrawbackEngine still owns the
outer tree, hidden-rule state, legal-move masks, literal king capture, and
terminal outcomes. UCI never receives drawback IDs, hidden parameters, secret
state, or private move history.

This is an offline simulation and research path. It is not a live-game helper
and does not connect to or play on competitive websites.

## Private configuration

Select `node-uci-leaf` after the training profile and provide an untracked JSON
configuration path:

```bash
pnpm --filter @drawbackengine/cli player-private:batch -- \
  train 1000 200 200 8 448663553 1785536514 2586451971 \
  /trusted/output/train.ndjson \
  120 32 2 50000 35 standard node-uci-leaf \
  /trusted/config/stockfish.json
```

The configuration is schema version 1 and rejects unknown fields:

```json
{
  "schemaVersion": 1,
  "kind": "stockfish",
  "executablePath": "/absolute/path/to/stockfish",
  "executableSha256": "<lowercase SHA-256>",
  "cwd": "/absolute/private/runtime-directory",
  "shutdownTimeoutMs": 2000,
  "runtimeContextSha256": "<lowercase SHA-256>",
  "clientTimeoutMs": 10000,
  "uciName": "Stockfish 18",
  "version": "18",
  "advertisedOptionsSha256": "<lowercase SHA-256>",
  "depth": 8,
  "hashMb": 128
}
```

`runtimeContextSha256` is a caller-pinned digest of the canonical manifest for
every evaluation-affecting external asset or environment input selected by
`cwd` or `args`, including external NNUE networks. A verified self-contained
build with no external runtime inputs uses the SHA-256 of canonical `[]`:
`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
Changing the working directory or arguments in a way that changes evaluation
semantics requires a new digest. The loader binds this claim into provenance;
the caller remains responsible for constructing the authenticated manifest.

`args` is an optional array of single-line process arguments. Fairy-Stockfish
uses `"kind": "fairy-stockfish"` and additionally requires absolute
`variantPath` and pinned `variantSha256` fields. The committed
`data/catalog/drawbackchess-fairy-v1.ini` file is the supported variant
definition.

Do not commit the private configuration, executables, generated traces, or
model data. The CLI output includes only path-free progress and completion
JSON. It never prints the configuration path or output path.

## Authentication and lifecycle

Before launch, the parent pool copies the selected executable into a new
private temporary directory, hashes that exact copy, and spawns only the
verified copy. This closes replacement of the original source path between
copying and authentication. The boundary does not defend against a hostile
process running as the same operating-system account and mutating the private
staging directory. The process must then report the caller-pinned UCI name and
exact ordered option surface.

Authentication proves which executable bytes were selected; it is not a
sandbox or a safety review of those bytes. The UCI child inherits the parent
environment and runs with the caller's ordinary filesystem and network
permissions. Use only trusted engine binaries in a deliberately limited
runtime environment. Do not place unrelated secrets in that environment.

Each parent-owned worker slot owns one long-lived UCI process. The search
worker owns only the drawback-aware tree and an authenticated evaluator proxy.
It sends bounded public leaf snapshots to its parent slot using messages bound
to the pool, worker generation, task attempt, and evaluation ID. The parent
slot validates every message before forwarding a leaf to UCI and validates the
same correlation fields on the response. A worker cannot choose an executable,
change engine options, or address another slot's evaluator. Executable paths,
working directories, process arguments, runtime manifests, and Fairy variant
bytes remain parent-only and are projected out of worker initialization data.

The evaluator is authenticated before the worker announces readiness and is
reused across bounded simulation windows. The authenticated evaluator ID is
checked by the parent, worker, and every returned search-policy record.
Parent ownership is deliberate: even if a worker never authenticates, ignores
shutdown, crashes, or must be force-terminated, the parent can independently
abort the active search, close the engine process, and remove its staged copy.
All initialization writes, readiness barriers, searches, and shutdown waits
have absolute deadlines. Failed cleanup reports whether the process was
actually terminated and whether private resources were removed; it is never
treated as a clean stop. Authenticated worker-transport failures retry the
unchanged assignment in a fresh slot only after parent-owned cleanup succeeds.
Evaluator authentication and pre-readiness failures surface directly.

The batch CLI converts the first catchable `SIGINT` or `SIGTERM` into one
cooperative abort. It waits for the active batch result and exact pool cleanup,
returns the source iterator, removes unpublished or just-published private
output through the atomic rollback path, and retries any retained owners before
using exit code 130 or 143. Repeated catchable signals do not start duplicate
cleanup.

This is not an operating-system process-tree containment boundary. `SIGKILL`,
Task Manager force termination, machine loss, and runtime crashes cannot run
JavaScript cleanup; a trusted engine that launches its own descendants is also
outside the owned-child contract. Those events can leave staged executables or
private temporary output for manual recovery. Run long jobs in an external job
or container boundary when forced-termination cleanup is required.

The generic prepared-catalog batch APIs use the same ownership boundary. They
create one authenticated evaluator in the parent for each non-empty
round-robin shard and run that shard to completion before disposing it. The
ordinary simulation worker protocol rejects evaluator fields and every tagged
prepared-evaluator request. Earlier prepared worker schemas that carried a UCI
configuration into a thread are intentionally unsupported. When one shard
fails, the parent waits for all sibling shards to settle. It returns only after
cleanup is proven or with a typed handle that retains the same evaluator for
explicit cleanup retry.

Legacy player-private worker requests are restricted to the built-in material
policy. They cannot carry executable paths, process arguments, UCI options,
variant bytes, or another evaluator configuration. All authenticated UCI
configuration remains parent-owned.

The runtime fixes these options:

- `Threads=1`
- caller-pinned `Hash`
- `Ponder=false`
- `MultiPV=1`
- `UCI_Chess960=false`
- `UCI_LimitStrength=false`
- `Skill Level=20`
- empty `SyzygyPath`
- `Use NNUE=false` for the custom Fairy variant
- `Clear Hash` before every leaf request

The public evaluator ID binds executable bytes, engine identity, advertised
and fixed options, semantic process arguments, caller-pinned runtime-context
digest, search depth, and Fairy variant bytes. Host executable locations,
working-directory path strings, and operational timeouts do not change that
ID; any evaluation-affecting working-directory contents must change the
runtime-context digest.

## Fail-closed boundaries

Stockfish receives only orthodox-compatible public leaves and the exact
drawback-legal root mask. Fairy-Stockfish can score capturable-king leaves but
cannot represent an active castling king-en-passant right. Unsupported leaves,
missing root moves, incomplete fixed-depth searches, non-exact scores,
malformed UCI output, identity mismatches, and variant mismatches are errors.
There is no material-evaluator fallback.

The worker-to-parent leaf protocol omits move history because the authenticated
`node-uci-leaf/v1` adapters consume only the current FEN, turn, authority,
compatibility flags, and exact legal root moves. Adding history-sensitive UCI
semantics requires a new adapter and protocol version rather than silently
changing this boundary.

Worker results are not trusted merely because they came from an authenticated
thread. The parent reconstructs the exact `DrawbackGameSession`, regenerates
hidden parameters from the declared seeds, and replays every move. It compares
both legal masks, all observations, secret snapshots, FEN transitions, and the
terminal result before accepting a game.
