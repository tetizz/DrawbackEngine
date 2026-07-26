# Observed rule wave five

This wave adds 24 deterministic executable rules:

- Geometry and terrain: Crossing the Rubicon, True Love, Lethal Attraction,
  Thunderdome, Irresistible, Prima Donna, and Inside the Lines.
- Public-history responses: Boxing with Shadow, Cowardly, Going the Distance,
  Left to Right, Relay Race, Religious Dispute, Simon Says, Superstitious,
  Torpedos, and Stir Crazy.
- Stateful restrictions and deadlines: Bloodthirsty, Fixation, Leveling Up,
  Quicksand, Absolution, Moving Day, and Siege.

Irresistible is `partial`: its forced-adjacency behavior is executable, but
standard chess legality never produces a literal king-capture move for the
observed exception. The other 23 rules are `implemented-unverified`.
Observational descriptions do not justify `verified` status.

The complete machine-readable interpretations, fixture links, and individual
ambiguities are in `data/catalog/observed-rules-five.json`.

## Shared interpretations

- Distance is Manhattan distance and adjacency includes diagonals.
- The middle sixteen squares are files c-f and ranks 3-6. Thunderdome counts
  occupants of either color.
- The rim is files a/h or ranks 1/8.
- Response obligations are conditional on the ordinary legal move set. If an
  active obligation filters a nonempty ordinary set to zero, the session's
  generic start-of-turn drawback-loss check applies.
- Boxing with Shadow uses the opponent move's origin. Simon Says uses its
  destination. Castling uses the logged king endpoints unless a rule
  explicitly tracks the auxiliary rook.
- Left to Right currently means absolute a-to-h progression for both colors;
  the observed wording does not settle player-relative orientation.
- `PositionView.history` must be the complete chronological public move
  history. Predictor, replay, and session callers preserve this invariant.
- Quicksand and Absolution must initialize at game start and then transition
  incrementally. A final FEN plus moves cannot reconstruct historical
  middle-rank snapshots or prior bishop adjacency. Midgame imports therefore
  need supplied rule state; they must not silently claim exact reconstruction.
- Moving Day and Siege check loss after twenty completed turns by the affected
  player, at the start of that player's twenty-first turn.

Every rule has a fixture whose declared candidate moves are standard-chess
legal. Response-history fixtures are explicitly marked `contextOnly`: their
synthetic public histories isolate rule semantics and are not claimed to lead
to the declared FEN. Stateful fixture snapshots are likewise explicit rather
than inferred from unavailable private history. Moving Day and Siege also have
start-of-turn loss fixtures, while Bloodthirsty has a chronological
`GameSession` regression for the generic zero-filter loss path.
