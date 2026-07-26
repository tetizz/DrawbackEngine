# Observed rules, wave seven

This wave adds six parameterless rules from the community glossary and the
DrawbackDetector observation corpus. All remain `implemented-unverified`
until official rule text and complete edge behavior can be confirmed.

- **Friendly Fire** requires every primary mover's destination to be
  pseudo-defended by another own piece after the complete move.
- **Protected Pawns** applies that resulting-position defense requirement only
  to a primary pawn mover, including promotion.
- **Rook on the Seventh** requires White to move a rook onto rank 7, or Black
  onto rank 2, by that player's fifteenth turn. The fifteenth turn is forced
  when the condition is still unmet; the loss is checked at turn sixteen.
- **Rising Water** floods one rank from each affected player's home edge after
  every ten of that player's completed turns. A move may neither start nor end
  underwater.
- **Queen Disguise** tracks the original queen. Its first move locks later
  moves to rook-like or bishop-like geometry; promoted replacement queens do
  not inherit the restriction.
- **Now Kiss** independently and permanently unlocks captures by bishops,
  knights, or rooks after a same-type pair ends an affected-player turn on
  orthogonally or diagonally adjacent squares.

Friendly Fire and Protected Pawns count pseudo-defense, including pinned
defenders. Castling is constrained by the primary king destination, but the
relocated rook participates in the resulting defense. Queen Disguise assumes
history from the standard game start. Now Kiss must be tracked incrementally
or restored from persisted state because a past adjacency cannot be recovered
from only the current board and move list.

Machine-readable details and replay fixtures live in
`data/catalog/observed-rules-seven.json` and
`data/fixtures/rules/observed-seven/`.
