# Observed rule wave four

This wave turns 33 catalog entries into executable, deterministic rules:

- Board-relative restrictions: Cheerleaders, Noble Steed, Pack Mentality,
  Separation Anxiety, Separation of Church and State, Sibling Rivalry, Social
  Distancing, Spread Out, Torchlight, Royal Berth, Peons First, Power Cells,
  Leading the Charge, and Scouting Ahead.
- Public-history restrictions: Diplomatic Immunity, Flatterer, Hipster,
  Hedonic Treadmill, Ladies First, Centralized Command, Royal Jubilee, Monkey
  See, Haunted, Scorched Earth, Turn the Other Cheek, Velociraptor, Windup
  Toys, Doctor Octopus, and Cowering in Fear.
- Exact hidden-parameter rules: Crenellations, Theocracy, Active Volcano, and
  Comfort Zone.

All remain `implemented-unverified`. Their source descriptions are
observational rather than official executable specifications. The complete
machine-readable specification, parameter schemas, fixture links, and
rule-specific ambiguities live in
`data/catalog/observed-rules-four.json`.

## Shared interpretations

- Adjacency includes orthogonal and diagonal neighbors.
- “Ahead” and “behind” are relative to the affected player's color.
- Distance is Manhattan distance.
- A logged move's primary mover type is used unless a rule explicitly refers
  to the resulting piece; Hedonic Treadmill and Sibling Rivalry therefore use
  the promoted type.
- En-passant removes the pawn from its physical capture square before
  adjacency is assessed.
- Where wording refers to physical pieces or vacated squares, castling counts
  both the king and rook. Where wording refers to the logged mover type,
  castling is a king move. Rule-specific catalog ambiguities override this
  default when the observational wording does not settle the distinction.
- Own-turn and opponent-turn history windows count moves by that color, not
  plies.
- Hidden square, color, and parity parameters are fixed for the game. Active
  Volcano and Comfort Zone currently use the eight middle-board squares
  `c4`-`f5`, inferred from every available observation; that domain is not
  official or verified.
- A no-trigger turn preserves every ordinary legal move and should provide
  little predictor evidence.

Every rule has focused positive, negative, and relevant promotion, castling,
and en-passant tests. Board and parameterized rules have standard-legal replay
fixtures. History rules currently use reviewed synthetic history contexts;
their candidate moves are standard-legal in the declared position, but the
injected histories are not claimed to replay into that position.
