# Community glossary batch two

Last reviewed: 2026-07-24

These twelve rules are based on the player-compiled glossary in replies 5 and
13 of the Chess.com forum thread “all drawbacks.” Bottled Lighting appears in
reply 13; the other eleven appear in reply 5:

https://www.chess.com/forum/view/general/all-drawbacks

The source is attributable community evidence, not an official executable
specification. Every rule remains `implemented-unverified`.

## Shared interpretations

- Opportunity and forced-move rules inspect the complete ordinary-legal move
  set before applying the drawback.
- Multiple promotion encodings from one pawn are one physical origin when
  counting “different ways.”
- Promotion captures compare the moving pawn’s pre-promotion value and type.
- Castling is a king move and has travel distance two.
- En-passant is a pawn capture and uses its landing square for destination
  restrictions.
- “Left” is player-relative: decreasing file for White and increasing file for
  Black.
- The rim is files a/h and ranks 1/8.
- Piece values are pawn 1, knight 3, bishop 3, rook 5, queen 9, king infinity.

## Recorded ambiguities

- **Bottled Lighting:** the source title spells “Lighting,” not “Lightning.”
  The catalog preserves the observed title.
- **Covering Fire:** “two different ways” is interpreted as two distinct
  physical origins with ordinary legal captures to the target square. Pinned
  pseudo-attacks do not count.
- **Evil Twin:** the source contains a typographical error. Its knight example
  supports exact mover/target type identity.
- **Exclusivity Clause:** reachability means ordinary legal moves, not geometric
  pseudo-mobility.
- **Left for Dead:** left is interpreted from the affected player’s viewpoint.
- **Outflanked:** standard chess never captures a king, so the source’s king
  exception is inert. En-passant uses the landing square.
- **Punching Down** and **Simplifier:** promotion captures use the mover’s
  pre-promotion pawn value.
- **Bipartisanship:** a vertical move resets the horizontal direction streak.
  Castling counts as a horizontal king move.

The implementation deliberately excludes rules whose precise enforcement
requires opponent-owned state, attack maps, or richer compound-move metadata.
Those remain `unsupported` rather than silently approximated.
