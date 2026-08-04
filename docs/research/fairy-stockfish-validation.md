# Fairy-Stockfish validation

## Scope

Fairy-Stockfish is an optional heuristic below DrawbackEngine's exact outer
search. It is not the drawback rules authority. DrawbackEngine still generates
the public `capturable-king/v1` moves, applies the active rule filter, updates
hidden rule state, and adjudicates king capture and drawback loss.

The checked-in custom variant is:

```text
data/catalog/drawbackchess-fairy-v1.ini
SHA-256 06f444eddf2f4b42ca55e50e317411b01509ee3178c95ec5fcaf26cbdde2a5b9
```

It inherits chess geometry and sets:

```ini
king = -
commoner = k
castlingKingPiece = k
checking = false
extinctionValue = loss
extinctionPieceTypes = k
stalemateValue = loss
nFoldRule = 0
nMoveRule = 0
```

The commoner mapping is essential: Fairy-Stockfish otherwise adjudicates an
attacked royal king before applying the exact root mask, returning no move in a
non-terminal Drawback position. `castlingKingPiece=k` explicitly assigns the
inherited castling geometry to that commoner; the official variant checker and
real binary both accept the configuration.

## Real binary smoke

Validated on 2026-07-25 with the official `fairy_sf_14` Windows modern build:

```text
fairy-stockfish_x86-64-modern.exe
SHA-256 8ee199af88faebc4c87e1cfb5fb965716ea5eaf784ce59365900c96f2937ee2d
UCI name Fairy-Stockfish 14
```

The binary accepted the configuration:

```text
Fairy-Stockfish 14 by Fabian Fichter
Parsing variant: drawbackchess
```

It also accepted `e7e8` as a root move in
`4k3/4Q3/8/8/8/8/8/K7 w - - 0 1`, demonstrating literal king capture, and the
production TypeScript adapter returned an exact mate-normalized score for a
non-orthodox root mask that exposes the moving player's king.

The regression position
`rnbqkQnr/ppppp1pp/8/8/4p3/8/PPPP1PPP/RNB1KBNR b KQkq - 0 3` was also checked
with a 20-move exact root mask. The engine returned `e4e3` instead of the
incorrect terminal `bestmove (none)`. A castling-only mask on
`r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1` returned `e1g1`.

The release executable is not committed. Callers must acquire and authenticate
their own pinned binary.

The adapter authenticates the exact regular, non-symlink source bytes, writes
those bytes to a private read-only session path, loads only that copy through
UCI, and retains it until the evaluator closes. Replacing the caller's source
path during loading cannot change the bytes Fairy receives; the public digest
constant alone is not accepted as an attestation.

This is an artifact-integrity boundary, not a same-user security sandbox. A
malicious process running under the same operating-system principal and able to
alter another process's private temporary files is outside the threat model.

## Known parity boundary

The custom variant does not encode Drawback Chess's one-reply
castling-king-en-passant right. The outer engine carries that right in its
versioned public position snapshot. The Fairy adapter refuses a leaf while the
right is active.

Future castling inside Fairy-Stockfish's internal heuristic continuation can
still omit the site's special response. This is why the outer tree must search
real moves for several plies before the heuristic leaf and why the integration
is not labeled exact engine parity.

Before changing the configuration or promoting the engine's verification
status:

1. run `fairy-stockfish check` against the exact file;
2. verify its SHA-256 and UCI name;
3. compare authority move sets over a deterministic corpus;
4. include direct king capture, ignored check, pinned movement, king entry into
   attack, castling through attack, promotion, ordinary en passant, and the
   special castling response;
5. keep any unsupported state fail-closed.
