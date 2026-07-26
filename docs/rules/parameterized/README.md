# Parameterized drawback rules

These rules are sourced from the player-compiled glossary in reply #5 of the
Chess.com forum thread
[“all drawbacks”](https://www.chess.com/forum/view/general/all-drawbacks).
That list records rules the author discovered; it is not an official executable
specification. All three implementations are therefore
`implemented-unverified`.

Parameters are generated once from the session's deterministic random source.
They remain secret from the opponent and predictor. Filters receive ordinary
legal chess moves and return new arrays without mutating their inputs.

## Untitled Duck Drawback

Sourced wording: “There is a duck sleeping on (random square). You can't pass
through it or land on it.”

DrawbackEngine generates any of the 64 squares uniformly. A primary mover
cannot land on the square. For straight or diagonal movement, every traversed
square after the origin is checked, so sliders, two-square pawn moves, and the
king's castling path cannot pass through the duck. Knights have no intermediate
path and are restricted only from landing on it.

Ambiguities:

- The source does not say whether the square is limited to initially empty
  squares. This implementation samples all 64 squares.
- Only the primary mover's path is checked. During castling, the rook's
  secondary relocation is not separately filtered.
- A piece already on the duck square may move away. The source does not define
  initial overlap or interactions with transformed movement.
- En-passant is checked by the capturing pawn's path and destination; the
  removed pawn's square is not a traversed square.

## Just Passing Through

Sourced wording: “You can't capture on the (random number) rank.”

DrawbackEngine uniformly selects ranks 1 through 8. A legal capture is removed
when its destination is on the hidden rank. Quiet moves to the rank remain
legal. En-passant is classified by its landing rank, and capturing promotions
by their promotion-square rank. Castling is non-capturing.

Ambiguities:

- The source does not clarify whether “on” refers to the capturing piece's
  destination or the captured piece's square. They differ for en-passant; this
  implementation uses destination consistently.
- Rank numbering is absolute chess notation, not relative to player color.

## Gambler

Sourced wording: “Can't move a specific piece type, re-randomized every move.”

DrawbackEngine generates one hidden 32-bit seed. The active forbidden type is
derived from that seed and the number of moves previously applied to the
affected player's rule state. The six types are pawn, knight, bishop, rook,
queen, and king. Recalculation occurs after every affected-player move and may
naturally select the same type on consecutive turns. This provides deterministic
replay without requiring random access in `applyMove`.

A promotion is a pawn move on its promotion turn. On later turns, the promoted
piece uses its current type. Castling is a king move; the secondary rook is not
classified separately.

Ambiguities:

- The source does not state the random distribution. This implementation uses
  a deterministic uniform modulo selection from a mixed 32-bit value.
- “Every move” is interpreted as every affected-player turn, not every ply in
  the game.
- The source does not define the result when all ordinary legal moves use the
  forbidden type. The filter returns an empty set for session-level policy.

## Verification promotion

Official glossary text or reproducible original-site observations must settle
the listed ambiguities before any status becomes `verified`. Required fixtures
include both colors, empty filtered sets, castling, promotion, en-passant, and
deterministic parameter replay where applicable.
