# Expanded non-transforming drawback rules

Last reviewed: 2026-07-24

This bounded batch uses the same player-compiled glossary already identified in
`docs/research/remaining-milestone-rules.md`: Truc1231, reply #5 in the
Chess.com forum thread “all drawbacks,” posted June 18, 2024. The glossary is
attributable community evidence, not an official executable specification.
Every rule therefore remains `implemented-unverified`.

All five rules filter a fresh ordinary-legal move array and never add moves.
“Primary mover” follows the project convention: castling is classified by the
king, and promotion by the pawn before it moves.

## Number of the Beast

Sourced wording: “You can’t move to the sixth rank.”

Executable interpretation: reject any move whose primary destination has rank
6. The restriction applies from both colors' perspectives and includes
captures, en-passant destinations, and promotions in constructed positions.
Castling is unaffected because neither king destination is on rank 6.

Ambiguity: “sixth rank” is interpreted as absolute board rank 6, not the
affected player's sixth rank from their perspective. Standard chess notation
supports that reading, but original-site confirmation is still required.

## Shadow Queen

Sourced wording: “Your queen can only move to dark squares.”

Executable interpretation: reject a move by a queen when its destination is a
light square. A1 is treated as dark under the standard board coloring. Moves
by every other primary piece are unaffected, including a pawn promoting to a
queen on that move.

Ambiguity: the source does not say whether “your queen” means the original
physical queen or every current queen after promotion. The implementation uses
the mover's current pre-move type, matching the repository's promotion
convention.

## Entrenched

Sourced wording: “Your rooks can’t move more than 2 squares.”

Executable interpretation: a rook move may travel one or two board squares,
but not three or more. Captures and quiet moves use the same limit. Castling is
a king move, so its secondary rook relocation is not separately restricted.

Ambiguity: the glossary does not discuss castling's rook. Primary-mover
classification is a platform convention rather than sourced behavior.

## No Shuffling

Sourced wording: “Your rooks can’t move sideways.”

Executable interpretation: reject a rook move whose origin and destination
share a rank; vertical rook moves remain permitted. Captures follow the same
direction test. Castling is a king move and is unaffected.

Ambiguity: “sideways” is interpreted as horizontal on the displayed board,
independent of player color. Secondary castling movement is undocumented.

## Stop Stalling

Sourced wording: “Your pieces can’t move laterally.”

Executable interpretation: reject every primary move whose origin and
destination share a rank. This includes horizontal king, queen, and rook moves.
Diagonal, vertical, and knight moves with a rank change remain available.
Castling is forbidden because its primary king move is rank-neutral.

Ambiguity: “laterally” could conceivably include a knight's horizontal
component. The implementation uses the ordinary geometric meaning of a move
with no rank change and does not decompose a knight jump into components.

## Verification status

Each replay fixture demonstrates normal filtering, and the focused suite covers
allowed and forbidden moves, captures, promotions, en-passant, castling, both
colors where perspective could be confused, invalid-square rejection, evidence
messages, immutability, and fixture/catalog consistency. Official glossary
text or reproducible original-site observations are still required before any
entry can become `verified`.
