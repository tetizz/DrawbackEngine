# Community capturable-king compatibility wave

Last reviewed: 2026-07-28

This audit extends five existing community-glossary rules from
`standard-chess/v1` to `capturable-king/v1`:

- Greedy
- Out of Breath
- Queen Bee
- Alternator
- Hopscotch

It does not change their documented semantics or upgrade their
`implemented-unverified` status. The source descriptions remain attributable
community evidence rather than an official executable specification.

## Version boundary

The historical player-private ruleset v2 remains an immutable, ordered
25-label vocabulary. Version three remains the immutable 37-rule authority
compatibility registry introduced by the earlier compatibility wave.

The engine exposes the additive
`AUDITED_CAPTURABLE_KING_RULE_IDS_V4` registry with those same 37 IDs followed
by the five rules in this document. Version four is an authority-compatibility
registry, not a player-private training release. Existing trace producers,
parsers, simulation schedules, and model vocabularies continue to use the
25-label v2 tuple until they explicitly define a new versioned contract.

## Shared authority contract

The position authority generates moves before the active drawback filters an
immutable copy of that move set. Direct and castling-en-passant king captures
therefore participate in opportunity checks, history restrictions, and
alternation exactly like other moves. A surviving king capture becomes
terminal only after it is applied.

The primary pre-move piece and its `from` and `to` squares control
classification:

- promotion is a pawn move;
- castling is a king and non-pawn move;
- ordinary en-passant is a pawn move whose destination is its landing square;
- castling-en-passant uses the authority-generated capturing piece and landing
  square.

## Rule interpretations and open ambiguities

### Greedy

Quiet moves remain unrestricted. A capture is permitted only when its target
has the greatest value among all authority-generated captures. The opposing
king has infinite value, so an available king capture suppresses every finite
capture but does not suppress quiet moves. If more than one king capture is
available, all tied king captures remain eligible.

This compares target value, not exchange value or the quality of the resulting
position.

### Out of Breath

The affected player may make one move whose primary mover is a king. Castling
consumes that allowance. A direct king-on-king capture is eligible only before
the allowance is consumed. A castling-en-passant king capture is treated the
same way when the authority identifies the capturing piece as a king.

The first king capture ends the game, so its resulting incremented state is
not observed on a later turn.

### Queen Bee

After any capture whose primary mover is a queen, every later queen move is
forbidden. This includes later direct and castling-en-passant king captures.
A queen's first capture may itself capture the opposing king and end the game.

A pawn that promotes to a queen is still a pawn mover during the promotion.
If the freeze was already armed, that promoted queen is frozen on subsequent
turns along with every other current queen.

### Alternator

The affected player's first move is unrestricted. Later moves must alternate
between pawn and non-pawn primary movers. A capture of the opposing king is
not an exception. Promotion and ordinary en-passant are pawn moves; castling
is a non-pawn move; castling-en-passant follows its generated primary mover.

Only the affected player's own completed moves update its alternation state.

### Hopscotch

The affected player's first move is unrestricted. Later move destinations
must alternate between dark and light squares, with `a1` dark. A king capture
is not an exception. Promotion uses the pawn landing square, ordinary
en-passant uses the pawn landing square, castling uses the king destination,
and castling-en-passant uses its generated landing square.

Only the affected player's own completed moves update its destination-color
state.

## Verification scope

Focused tests cover:

- immutable authority-move filtering;
- both colors for the move-set-dependent Greedy rule;
- permitted and forbidden direct king captures;
- stateful trigger sequences and player-state persistence;
- promotion, castling, and ordinary en-passant classification;
- permitted and forbidden castling-en-passant king captures;
- frozen v2, v3, and v4 registry order and subset boundaries.

These tests certify the documented interpretations under
`capturable-king/v1`. First-party source replays are still required before any
rule can become `verified`.
