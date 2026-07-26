# Observed rules, wave ten

This wave adds five rules whose public wording can be represented as exact
filters or losses over standard legal chess. They remain
`implemented-unverified`: the implementation is executable and tested, but
the available community wording and observation corpus do not settle every
edge case.

- **Expedition** forces the affected player's fifteenth primary move to end on
  f1. The one observed sample is treated as fixed, though it may represent an
  undiscovered parameterized family.
- **Reflective** exempts pawns and requires every other primary destination's
  horizontal reflection across ranks four and five to be occupied before the
  move.
- **Eye of Sauron** uses the farthest player-relative rank occupied or
  ordinarily reachable by any own rook as a frontier. Non-pawns may not move
  beyond it; promoted rooks count and no-rook positions are unrestricted.
- **Drag** limits the original queen to one-square king geometry. Its capture
  causes a loss at the beginning of the owner's next turn. The queen is not
  treated as a second royal piece, and promoted queens do not replace it.
- **Ooh Shiny** forces a capture when the capturing piece cannot be recaptured
  legally on its destination. Candidate positions are replayed through
  `chess.js`, so pinned pseudo-attackers do not count as legal recapturers and
  checking, mating, en-passant, and promotion captures receive normal standard
  chess treatment.

Every filter starts from ordinary legal moves and returns a fresh array.
Expedition's unsatisfied deadline and other all-filtered positions use the
shared no-drawback-legal-move loss. Drag reconstruction assumes complete
history from the standard starting position. Reflective uses pre-move
occupancy and a horizontal center line; these choices are documented because
the source wording does not establish the axis or timing.

The remaining unsupported rules were not approximated in this wave. Death
Wish needs a move generator that can add normally illegal king moves; Fog of
War needs player-scoped observations; literal king-capture rules need a
termination model beyond ordinary `chess.js` checkmate; and several random
terrain/deadline rules still lack reliable parameter domains. Hand and
Gigabrain and Ichtyophobe were implemented later through the deterministic
asynchronous UCI constraint architecture.

Machine-readable specifications and replay fixtures are in
`data/catalog/observed-rules-ten.json` and
`data/fixtures/rules/observed-ten/`.
