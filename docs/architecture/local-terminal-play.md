# Local player-private play

The terminal play command is a local human-versus-engine surface over the same
capturable-king authority and player-private search used by the simulation
system. It is intended for testing DrawbackEngine itself, not for assistance on
an external chess site.

## Start a game

Build the workspace, then provide an absolute authenticated evaluator policy:

```powershell
pnpm --filter @drawbackengine/cli play -- `
  --evaluator-config C:\trusted\fairy-stockfish.json `
  --human-color white `
  --human-drawback random `
  --seed 12345 `
  --max-depth 2 `
  --max-nodes 50000
```

Moves use explicit coordinates, for example `e2-e4` or `e7-e8=Q`. The
commands `board`, `moves`, `drawback`, `help`, `resign`, and `quit` are also
available. The board is always oriented with the human player at the bottom.

The command currently selects only from the frozen 25-rule
`AUDITED_CAPTURABLE_KING_RULE_IDS_V2` registry. Unsupported catalog entries are
not silently treated as unrestricted chess.

## Privacy and ownership boundary

One `PlayerPrivatePlayGame` owns one authoritative `DrawbackGameSession` for
the whole game. The human receives a complete public board, their own drawback,
and opaque position-scoped action capabilities. The projection contains no
FEN, SAN, captured-piece field, random seed, raw rule parameters/state, or
opponent secret. Action capabilities expire after every accepted move.

The engine receives its own exact rule capability and public hypotheses about
the human rule. It does not receive the human's actual rule. The terminal does
not expose the engine score or hypothesis count; it reports only the played
move, the configured target depth and node cap, and the path-free evaluator
ID. Achieved depth and visited-node counts stay inside the trusted search
boundary because rule-dependent work totals can reveal hidden constraints.
Both true drawbacks are revealed only after a game ending or human
resignation. Quitting does not reveal them.

Exactly one authenticated UCI evaluator is created for a game. Its executable,
runtime inputs, declared identity, UCI options, and hashes must match the
caller-pinned policy. The evaluator is closed by the same owner on success,
failure, or cancellation. An incomplete close is retried only through that same
owner handle; a replacement process is never created.

`SIGINT` and `SIGTERM` become cooperative cancellation signals for evaluator
startup, active search, and terminal input. A cancelled search is checked again
before the selected engine move can enter the authoritative session.

## Exact king-passant extension

The game authority implements the one-reply castling king-passant right. The
Fairy-Stockfish leaf format cannot encode that right in FEN, so the leaf
adapter still rejects an active right if called directly. Player-private search
does not send such a position to UCI: its exact outer extension advances every
live hidden-rule world through a rule-legal reply first. A king capture ends
the branch, a declined capture expires the right, and a reply that castles can
arm the opposite one-reply right for the same recursive handling. If the node
budget is exhausted during this extension, search selects a deterministic
legal conservative fallback without asking UCI to evaluate incomplete
authority state. Local play therefore preserves the extension instead of
approximating it or stopping the game at that position.

Search depth and nodes are configuration, not a published Elo claim. Use the
paired strength harness for measured comparisons; a single local game is only
an interactive smoke test.
