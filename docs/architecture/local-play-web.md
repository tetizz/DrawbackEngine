# Local browser play boundary

`apps/play-web` is a local human-versus-engine surface. It is not a remote
service, a browser extension, or a live-game integration. The Node process
binds only to `127.0.0.1`, serves the production React bundle, owns one
authenticated Fairy-Stockfish evaluator, and keeps the authoritative drawback
session in memory.

Interactive browser play intentionally uses the frozen audited 25-rule
player-private catalog. The broader authority-compatible and observed catalogs
are not presented as fair-search browser support.

## Trusted flow

1. The process loads a caller-pinned evaluator configuration and rejects every
   kind except Fairy-Stockfish. Orthodox Stockfish cannot represent all
   capturable-king leaves.
2. `PlayerPrivatePlayGame` creates the authoritative game. The human chooses
   only their color and an audited own drawback; the opponent drawback and all
   parameters are selected privately.
3. The page receives `PlayerPlayObservationV1`, coordinate-only public move
   history, the chosen exact search preset, sanitized evaluator settings, and
   a reveal only after termination.
4. A human move returns a random position-scoped action capability. The server
   submits that capability to the persistent game and rejects stale ply/action
   pairs.
5. Every computer reply calls `PlayerPrivatePlayGame.playEngineTurn` with the
   exact preset `maxDepth` and `maxNodes` and the authenticated evaluator.
   Search is serialized across games because the evaluator is a single owned
   UCI process.

The three presets are compute budgets, not measured ratings:

| Preset | Outer target depth | Outer node cap |
| --- | ---: | ---: |
| Quick | 1 | 5,000 |
| Balanced | 2 | 50,000 |
| Deep | 3 | 250,000 |

## Browser projection

Before game termination, responses omit the opponent drawback and parameters,
FEN, SAN, captured-piece type, seed, rule state, evaluator IDs, executable and
variant paths, scores, principal variations, hypothesis counts, completed
depth, and visited-node counters. Completed-work counters are deliberately
omitted because hidden-rule branching can influence them. The selected static
budget is safe to show and stays visible in the interface.

Post-game reveal uses the facade's fail-closed `reveal()` method. Calling it
while a game is active returns HTTP 409.

## HTTP and lifecycle

- All sockets bind to IPv4 loopback. Requests must also have a loopback remote
  address and an exact `127.0.0.1` or `localhost` Host header for the bound
  port.
- Mutating requests require an exact same-origin `Origin` and a random
  `HttpOnly; SameSite=Strict` owner cookie. No CORS headers are emitted.
- Responses set a restrictive content security policy, frame denial, no-sniff,
  same-origin resource policy, and no-referrer policy. API responses are never
  cached.
- Starting a replacement game aborts and awaits the previous search before the
  evaluator is reused. Server shutdown aborts and awaits every active search,
  closes HTTP, and then closes the same evaluator owner.
- Incomplete evaluator cleanup is retried only through that retained owner.
  Failures that already prove process termination and private-resource removal
  are preserved without a redundant close. Listen/startup failures aggregate
  the primary failure with application, socket, and evaluator cleanup failures.
- `SIGINT` and `SIGTERM` abort startup or search, complete cleanup, and preserve
  exit 130 or 143 only when cleanup succeeds. Cleanup failure is reported as an
  error instead of being hidden behind a signal exit.

The app does not deploy, contact external chess sites, or expose an endpoint on
the LAN.
