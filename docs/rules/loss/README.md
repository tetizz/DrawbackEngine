# Start-of-turn loss drawback specifications

Last reviewed: 2026-07-24

These twelve rules implement explicit loss conditions found in the community
glossary and the DrawbackDetector observation corpus. Every rule remains
`implemented-unverified`: the source wording is attributable, but it is not an
official executable specification.

## Timing

Loss predicates run at the beginning of the affected player's turn, before
standard chess ending checks. The symbolic predictor evaluates the same
predicate before accepting an observed move and hard-eliminates hypotheses
under which the player had already lost.

## Shared interpretations

- “Pieces” includes pawns and kings.
- Promoted pieces count as their current type.
- Hold Them Back uses color-relative board halves.
- Homeland Security uses each color's home two ranks.
- King of the Hill's first-turn exemption is tracked independently per color.
- Ivory Tower uses physical orthogonal or diagonal adjacency.
- Tower Defense forbids rook moves and loses when the affected player has no
  rook at the start of a turn.
- Warlord's deadline is the start of the affected player's twelfth turn, and
  home means that color's two home ranks.

Fischer Random and Moving Day are executable under their documented
affected-turn deadline interpretations. Inching Forward remains unsupported
because its wording does not settle exact-rank versus minimum-rank behavior,
continuous versus checkpoint enforcement, or the boundary after rank eight.
