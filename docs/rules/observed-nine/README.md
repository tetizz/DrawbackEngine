# Observed rules, wave nine

This wave implements four independently rerandomized per-turn rules from the
player-compiled glossary and DrawbackDetector corpus. Each is
`implemented-unverified`: the public wording is preserved, the selected
interpretations are executable and tested, but official edge behavior remains
unconfirmed.

- **Colorblind** forbids primary destinations of one square color. Dark and
  light are equally likely.
- **Hand and Brainless** requires one primary mover type selected with an
  approximately uniform deterministic uint32 mapping from pawn, knight,
  bishop, rook, queen, and king. Modulo-six mapping has a negligible
  one-preimage bias because 2^32 is not divisible by six.
- **Obsession** samples one of all 64 squares. If at least one ordinary legal
  move reaches it, only moves to that square remain legal; otherwise the rule
  is inactive for the turn.
- **Winds of Fate** forbids either leftward or rightward file displacement from
  the affected player's perspective. Vertical moves remain legal, and Black's
  file directions mirror White's.

The choice is stable while a player considers a turn and rerandomizes only
after that affected player moves. Executable sessions derive each choice from a
secret uint32 seed and the affected player's own move count, making replays and
parallel simulations deterministic. Filters never consume mutable randomness,
so repeated legal-move queries cannot change the constraint.

The predictor never sees or attempts to classify the engine seed. Instead it
keeps one public hypothesis with `{}` parameters per rule and analytically
marginalizes the complete current-turn outcome domain. A rule is hard-eliminated
only when every possible outcome rejects the observed move. Training records
retain the trusted seed for exact replay, but parameter vocabularies and losses
mask the opaque `seed` label so it cannot leak into model inputs or become an
unlearnable target.

Promotion is classified by the primary pawn move, castling by the primary king
move, and en-passant by the capturing pawn's endpoint. Colorblind and Winds may
filter every ordinary legal move. Hand and Brainless deliberately follows the
literal “must move” wording and has no fallback when the selected type cannot
move; those cases use the engine's generic no-drawback-legal-move loss.

Machine-readable specifications and deterministic replay fixtures are in
`data/catalog/observed-rules-nine.json` and
`data/fixtures/rules/observed-nine/`.
