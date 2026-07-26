# Observed rule wave six

This wave adds 17 deterministic executable rules:

- Current-position attack restrictions: Deer in the Headlights, Jumpy,
  Medusa, Stand Your Ground, and Unrequited Love.
- Board-state losses and unlocks: Helicopter Parent, Paranoid, and Rook
  Buddies.
- Public-history and check responses: Atomic Bomb, Get Down Mr. President,
  Guerilla Tactics, Prince Charming, Savior Complex, Shellshocked, Skittish,
  Sleepy King, and Three Check.

All 17 are `implemented-unverified`. Their wording comes from observations,
not an official executable specification. Machine-readable interpretations,
fixture links, and rule-specific ambiguities live in
`data/catalog/observed-rules-six.json`.

## Shared interpretations

- “Attacked” and “defended” mean pseudo-attacked in the current position.
  Pinned pieces therefore still attack or defend squares.
- Medusa considers opponent queen rays only. A rook or bishop attacking along
  the same line does not petrify a piece.
- “When possible” is evaluated over ordinary standard-legal moves. An
  attacked piece with no ordinary move does not activate Jumpy.
- Castling is normally a king primary move. Rook Buddies explicitly locks
  castling because it moves the auxiliary rook; Shellshocked also checks the
  auxiliary rook origin.
- En-passant capture effects use the removed pawn square for Atomic Bomb and
  Shellshocked.
- Check-response rules use standard chess check legality. DrawbackChess.com
  may use a capturable-king model, so positions reachable there can differ
  from this standard-chess training engine.
- Three Check relies on complete chess.js SAN history, where `+` and `#`
  identify checks. This dependency is explicit rather than inferred from a
  final FEN.
- Response-history fixture histories marked `contextOnly` isolate a rule
  condition and are not claimed to replay chronologically into their FEN.

Every declared candidate move is verified as standard-chess legal. Loss rules
have start-of-turn fixtures, and all rules are registered in the symbolic
predictor and deterministic simulation catalogs.
