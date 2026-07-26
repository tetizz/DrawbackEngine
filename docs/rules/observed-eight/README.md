# Observed rules, wave eight

This wave adds seven rules supported by the player-compiled glossary and the
DrawbackDetector observation corpus. They are `implemented-unverified`: the
engine behavior is executable and tested, but official edge semantics have
not been independently confirmed.

- **Bishop Fan Club** requires bishop promotion and diagonal primary moves by
  kings and queens. Castling is therefore forbidden.
- **Rook Fan Club** requires rook promotion and orthogonal primary moves by
  kings and queens. Standard-legal castling remains available.
- **Respectful** rejects every move whose complete resulting position checks
  the opponent, including discovered checks, promotion checks, en-passant
  discoveries, castling-rook checks, and checkmate.
- **Shapeshifter** tracks the original queen. It begins bishop-like and copies
  the current type of every non-pawn captured by any affected-player piece.
  A copied knight freezes the queen. Promoted queens are not tracked.
- **Fischer Random** requires every surviving non-pawn to occupy the affected
  player's home rank, on a file where its current type could not normally
  start, by affected turn twenty. The invariant remains enforced afterward.
- **Unspooling** spends Manhattan distance from a 100-unit primary-move
  budget. Castling costs the king's endpoint distance. Spending the final
  unit causes a loss at the start of the affected player's next turn, unless
  that move already ends the game by standard checkmate. If no ordinary legal
  move fits the remaining budget, the generic no-drawback-legal-move loss
  applies.
- **Blinded by the Sun** forbids resulting positions that pseudo-attack a
  hidden central square. The executable parameter domain is the four squares
  observed in the corpus: d4, e4, d5, and e5.

Shapeshifter reconstruction assumes a complete history from the standard
starting position. Fischer Random evaluates promoted pieces by their current
type and ignores captured pieces. Blinded by the Sun counts pinned pieces as
attacking because the public wording does not distinguish legal attacks from
pseudo-attacks.

Machine-readable specifications and replay fixtures are in
`data/catalog/observed-rules-eight.json` and
`data/fixtures/rules/observed-eight/`.
