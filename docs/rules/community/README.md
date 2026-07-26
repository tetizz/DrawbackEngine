# Community glossary batch

Last reviewed: 2026-07-24

These fifteen implementations are based on the player-compiled Drawback Chess
glossary posted by Truc1231 in reply 5 and reply 13 of the Chess.com forum
thread “all drawbacks”:

https://www.chess.com/forum/view/general/all-drawbacks

This is attributable community evidence, not an official executable
specification. Every entry is therefore `implemented-unverified`.

The engine continues to generate standard-chess legal moves first. These rules
only remove moves from that immutable input. Castling and promotion are
classified by the primary mover: king and pre-promotion pawn respectively.

## Shared interpretations

- Piece values are pawn 1, knight 3, bishop 3, rook 5, queen 9, king infinity.
- “Adjacent” includes orthogonal and diagonal adjacency.
- Distance is Manhattan distance unless the source explicitly describes
  diagonal squares. Snipers' four diagonal squares therefore equal Manhattan
  distance eight.
- “Your two home ranks” means ranks 1 and 2 for White and ranks 7 and 8 for
  Black.
- Opportunity rules inspect the complete ordinary-legal move set before this
  drawback filters it.
- A physical piece is identified by its source square during a turn.
- Alternator and Hopscotch leave the affected player's first move unrestricted.

## Rule-specific ambiguities

- Greedy compares captured target value, not exchange value, and quiet moves
  remain legal.
- Professional Courtesy applies only when the target is a non-pawn piece; this
  follows the source's explicit “non-pawn pieces” wording.
- Snipers does not restrict quiet bishop moves.
- Stay at Home Mom applies to every current queen, including promoted queens
  on later turns.
- Far Sighted measures origin-to-destination adjacency. En-passant is therefore
  classified by the move destination rather than the captured pawn's square.
- Whites of Their Eyes follows the repository-wide Manhattan definition even
  though the original implementation's metric is not independently confirmed.
- Champing at the Bit allows diagonal pawn captures because their Manhattan
  distance is two. It forbids ordinary single pushes and allows legal double
  pushes.
- The Scent of Blood is local to the physical piece that has a capture; it does
  not force a capture by a different piece.
- Indecisive removes the captures of a piece with multiple capture choices but
  leaves that piece's quiet moves available.
- Control Center exempts captures and treats files c through f as the four
  central files.
- Out of Breath counts castling as the player's one king move.
- Queen Bee freezes every current queen after any queen capture.
- Promotion is a pawn move for Alternator and its destination color is used by
  Hopscotch.

Each catalog entry points to a compact replay fixture, while
`community-rules.test.ts` covers positive and negative movement, capture
geometry, special-move classification, immutable filtering, both-color
perspective, and state transitions. Original-site observations are still
required before any rule can become `verified`.
