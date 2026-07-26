# Observed rules, wave eleven

This wave adds two public drawback descriptions whose core behavior can be
represented by deterministic filters over standard legal chess. Both remain
`implemented-unverified` because the community wording is not a complete
official specification.

## Bridge Over Troubled Water

The middle ranks are interpreted as a two-rank river on ranks four and five.
The four squares on files d/e form a landable bridge; the other twelve river
squares are water and cannot be primary destinations. A rook, bishop, or queen
that moves completely from one bank to the other must traverse both river
ranks through files d/e. This path check prevents long-range pieces from
bypassing the destination restriction.

This interpretation is defensible but not proven by a board screenshot. The
source wording does not explicitly define the river ranks, whether bridge
squares are landable, or whether jumping pieces are constrained by their path.
The implementation applies the terrain to the primary mover and uses
destination semantics for knights, pawns, kings, castling, en-passant, and
promotion.

## Reconnaissance

The affected player begins unable to capture. On each affected-player turn,
the rule records every target piece type that could be captured by an ordinary
standard-legal move before the chosen move. Those types become capturable on
the player's next turn and remain unlocked for the rest of the game. Studying
does not depend on the move chosen, and pinned or otherwise illegal
pseudo-captures do not count.

The one-turn delay follows the wording “once you've studied them for a turn.”
En-passant studies a pawn, and promotion captures are gated by the captured
target type. Exact state is maintained during chronological play from the
starting position. A move-only midgame history cannot reconstruct past
unplayed capture opportunities, so arbitrary midgame initialization begins
with an empty learned set and remains an explicitly documented limitation.

Specifications and replay fixtures live in
`data/catalog/observed-rules-eleven.json` and
`data/fixtures/rules/observed-eleven/`.
