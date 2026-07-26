# Remaining first-milestone rule evidence

Last reviewed: 2026-07-24

## Evidence standard and sources

This note separates attributable public wording from DrawbackEngine's proposed
executable semantics. The principal source is Truc1231's player-compiled
glossary in reply #5 of the Chess.com forum thread
[“all drawbacks”](https://www.chess.com/forum/view/general/all-drawbacks),
posted in June 2024. The author introduces it as a list of drawbacks they
“discovered”; it is useful evidence, but not an official specification.
Forward March appears in the same author's later update, reply #13. A second
Chess.com discussion,
[“Drawback Chess”](https://www.chess.com/forum/view/general/drawback-chess),
independently reports True Gentleman as “Can't capture queens.”

The [official Drawback Chess landing page](https://www.drawbackchess.com/)
identifies the product and links an in-product glossary, but its public page
does not expose these definitions. No creator-authored executable
specification or special-move matrix was located. Consequently, the fourteen
forum-sourced rules below should be `implemented-unverified`, not `verified`.
The [InvalidSE/DrawbackDetector](https://github.com/InvalidSE/DrawbackDetector)
observation corpus additionally records False Prophets twice with the wording
“Your bishops can't capture.” This is reproducible observational evidence, so
False Prophets is executable but remains `implemented-unverified`.

Quoted fragments are deliberately short.

## Shared executable conventions

These are proposed DrawbackEngine conventions, not sourced claims:

- Begin with ordinary legal chess moves. A drawback never legalizes a move.
- A capture includes en-passant and a capturing promotion.
- “Last move” means the affected player's previous turn unless the wording
  explicitly says the opponent's move.
- “Move number” means the standard fullmove number: White and Black both act on
  move 1, then both on move 2. This is not the zero-based ply index.
- “Backwards” is toward the mover's home rank: decreasing rank for White and
  increasing rank for Black. A move is backwards when its destination rank is
  less advanced than its origin rank; lateral movement is not backwards.
- Castling is a king move with a secondary rook relocation. The primary mover
  is the king.
- A promoting move is made by a pawn. The promoted piece uses its resulting
  type on later turns.
- When a mandatory-action rule is active, retain all ordinary legal moves that
  satisfy it. If no satisfying move exists and the wording says “if able,” the
  rule is inactive. If the wording says “or lose,” evaluate a drawback loss at
  the affected player's start of turn when the obligation cannot be fulfilled.
- A filter that produces no move does not itself invent a result. The shared
  game-session policy must distinguish drawback loss from ordinary
  checkmate/stalemate.

## Rule findings

### True Gentleman

- **Attributable wording:** “Can't capture queens.”
- **Executable semantics:** reject an ordinary legal move exactly when its
  captured target is an opposing queen. The moving piece's type is irrelevant.
- **Special moves:** a capturing promotion onto a queen is forbidden.
  En-passant cannot capture a queen. Castling is non-capturing.
- **Ambiguities:** transformed pieces, royal queens, and combined-rule
  interactions are undocumented.
- **Status:** `implemented-unverified`.

### False Prophets

- **Attributable wording:** “Your bishops can't capture,” recorded twice in the
  DrawbackDetector observation corpus.
- **Executable semantics:** reject ordinary legal captures whose primary mover
  is the affected player's bishop. Quiet bishop moves remain legal.
- **Special moves:** promotion is a pawn move, so a capturing promotion to a
  bishop is not blocked on that turn. The promoted bishop cannot capture later.
- **Ambiguities:** transformed-piece identity and combined-rule interactions
  are undocumented.
- **Status:** `implemented-unverified`.

### Trophy Wife

- **Attributable wording:** “Your queen can't capture.”
- **Executable semantics:** reject each ordinary legal capture whose primary
  mover is the affected player's queen. Quiet queen moves remain available.
- **Special moves:** promotion is a pawn move, so a capturing promotion to a
  queen is not blocked on that turn. The promoted queen cannot capture later.
  En-passant is a pawn capture. Castling is unaffected.
- **Ambiguities:** transformed or disguised queens and whether identity or
  current type controls the rule are undocumented.
- **Status:** `implemented-unverified`.

### Cess

- **Attributable wording:** “You can't move to the h file.”
- **Executable semantics:** reject every ordinary legal move whose primary
  destination is on file h, regardless of origin, mover type, or capture.
- **Special moves:** a promotion or capture landing on h is forbidden.
  En-passant landing on h is theoretically covered if legal in a constructed
  position. Kingside castling ends the king on g, so it remains allowed even
  though the rook secondarily lands on f; no castling destination is h.
- **Ambiguities:** whether a secondary relocation or movement path through h
  counts as “move to” is not stated. The proposed rule tests primary
  destination only.
- **Status:** `implemented-unverified`.

### Forward March

- **Attributable wording:** “Can't move backwards.”
- **Executable semantics:** reject a move when the primary mover's destination
  rank is closer to that mover's home edge than its origin rank. White rejects
  destination ranks lower than the origin; Black rejects higher ranks. Lateral
  and forward moves remain legal.
- **Special moves:** ordinary pawns never move backwards. Backward captures by
  non-pawns are forbidden. Promotions advance and remain allowed. En-passant
  advances. Castling is rank-neutral and allowed.
- **Ambiguities:** the source does not define perspective, whether lateral
  means non-forward, whether knights are compared only by rank, or whether a
  castling rook's relocation is separately checked. Manhattan distance is not
  a defensible substitute for directional rank progress.
- **Status:** `implemented-unverified`.

### Pacman

- **Attributable wording:** “If you can capture a pawn, you must.”
- **Executable semantics:** if any ordinary legal move captures an opposing
  pawn, retain all and only pawn-capturing moves. Otherwise retain every
  ordinary legal move. Captures of other piece types do not satisfy an active
  obligation.
- **Special moves:** legal en-passant captures activate and satisfy the rule.
  A promotion capturing a pawn activates and satisfies it. Castling is removed
  while the obligation is active.
- **Ambiguities:** “can” could mean pseudo-legal, but forcing an illegal move
  conflicts with ordinary-legal-first architecture. Interactions with another
  rule that forbids all pawn captures are unspecified.
- **Status:** `implemented-unverified`.

### Oddball

- **Attributable wording:** “You can only capture on odd-numbered moves.”
- **Executable semantics:** reject captures on even standard fullmove numbers;
  allow captures on odd fullmove numbers. Quiet moves remain available on
  every turn.
- **Special moves:** en-passant and capturing promotions use the same parity.
  Non-capturing promotions and castling are unaffected.
- **Ambiguities:** “moves” could mean fullmove numbers, individual plies, or
  the affected player's turn count. The proposed fullmove interpretation
  follows ordinary chess notation but requires original-site confirmation,
  especially for Black.
- **Status:** `implemented-unverified`.

### Even Keeled

- **Attributable wording:** “You can only capture on even-numbered moves.”
- **Executable semantics:** reject captures on odd standard fullmove numbers;
  allow captures on even fullmove numbers. Quiet moves remain available.
- **Special moves:** en-passant and capturing promotions use the same parity.
  Non-capturing promotions and castling are unaffected.
- **Ambiguities:** the same fullmove-versus-ply uncertainty as Oddball applies,
  with Black-side observations particularly important.
- **Status:** `implemented-unverified`.

### Quit Horsing Around

- **Attributable wording:** “If you moved a knight on your last move, you can't
  move a knight.”
- **Executable semantics:** record whether the affected player's previous
  primary mover was a knight. If so, reject every ordinary legal move by any of
  that player's knights on the next turn. A non-knight move clears the
  restriction.
- **Special moves:** knight captures are knight moves and set the state.
  Promotion to a knight is a pawn move on the promotion turn; the new knight
  can be restricted only after it later moves. Castling is a king move and
  clears a prior knight state.
- **Ambiguities:** the wording is equivalent to a knight-only piece-type
  alternation, but does not say whether the state survives a turn with no legal
  knight move or a skipped/terminal turn. Combined drawbacks are unspecified.
- **Status:** `implemented-unverified`.

### Remorseful

- **Attributable wording:** “You can't capture twice in a row.”
- **Executable semantics:** record whether the affected player's previous move
  was a capture. If it was, reject every capture on the player's next turn. A
  legal non-capture clears the restriction.
- **Special moves:** en-passant and capturing promotions set capture state.
  Quiet promotions and castling clear it.
- **Ambiguities:** “in a row” is interpreted across the player's consecutive
  turns, not adjacent plies. The source does not state what happens when every
  ordinary legal move is a capture.
- **Status:** `implemented-unverified`.

### Battle Fatigue

- **Attributable wording:** “When one of your pieces captures, it can't capture
  again until it has made a non-capturing move.”
- **Executable semantics:** track fatigue by physical piece identity. A
  capturing piece becomes fatigued. A fatigued piece may make ordinary legal
  non-captures; doing so clears its fatigue. Captures by other pieces are not
  blocked and create fatigue for those pieces independently.
- **Special moves:** en-passant fatigues its pawn. A capturing promotion
  fatigues the same physical piece after promotion; its first later move must
  be non-capturing. A quiet promotion clears existing fatigue on that pawn.
  Castling is a non-capture by the king; under primary-mover semantics it clears
  king fatigue but does not clear rook fatigue.
- **Ambiguities:** persistent identity across promotion, castling's rook, setup
  positions, and transformed pieces are not defined. It is unclear whether a
  fatigued piece that is captured needs retained tombstone state.
- **Status:** `implemented-unverified`.

### Eye for an Eye

- **Attributable wording:** the glossary contains the misspelled title “Ey for
  an Eye” and says, “If your opponent captures, you must capture on your next
  move, (or lose).”
- **Executable semantics:** after an opponent capture, the affected player has
  a one-turn capture obligation. At start of turn, retain all and only ordinary
  legal captures. If none exists, immediately record a drawback loss because
  the sourced wording expressly says “or lose.” A capture satisfies the
  obligation; an opponent quiet move creates none.
- **Special moves:** en-passant and capturing promotions both create and
  satisfy obligations. Castling cannot satisfy one. Only legal captures count.
- **Ambiguities:** the timing of “or lose” could mean loss after failing to
  choose an available capture rather than start-of-turn loss when none exists.
  The source does not say whether an existing obligation survives unusual
  skipped turns or how simultaneous start-of-turn endings are ordered.
- **Status:** `implemented-unverified`.

### Barbarian Rage

- **Attributable wording:** “If you captured on your last move, you must capture
  if able.”
- **Executable semantics:** record whether the affected player's previous move
  was a capture. On the next turn, if that state is true and at least one
  ordinary legal capture exists, retain all and only captures. If no capture is
  legal, allow all ordinary legal moves. The chosen move then replaces the
  state with whether it was a capture.
- **Special moves:** en-passant and capturing promotions set and satisfy the
  state. Quiet promotion and castling clear it.
- **Ambiguities:** “your last move” is interpreted as the player's prior turn.
  Pseudo-legal captures, no-move positions, and composition with restrictions
  that remove captures are undocumented.
- **Status:** `implemented-unverified`.

### Conscientious Objectors

- **Attributable wording:** “Can't capture with pawns.”
- **Executable semantics:** reject ordinary legal captures whose primary mover
  is an affected pawn. Quiet pawn moves and all moves by other types remain
  available.
- **Special moves:** en-passant is forbidden. A capturing promotion is
  forbidden because the mover is a pawn before promotion. A quiet promotion is
  allowed. Castling is unaffected.
- **Ambiguities:** transformed pieces and whether a promoted former pawn
  remains a pawn by identity are undocumented; current type after promotion is
  the defensible convention.
- **Status:** `implemented-unverified`.

### Horse Tranquilizer

- **Attributable wording:** “Your knights can't capture.”
- **Executable semantics:** reject ordinary legal captures whose primary mover
  is an affected knight. Quiet knight moves and captures by other piece types
  remain available.
- **Special moves:** en-passant is a pawn move. A capturing promotion to a
  knight is a pawn move and is allowed unless another rule forbids it; the
  promoted knight cannot capture on later turns. Castling is unaffected.
- **Ambiguities:** transformed pieces and whether identity before or current
  type controls later moves are undocumented.
- **Status:** `implemented-unverified`.

## Verification priorities

Before promoting any rule to `verified`, obtain official glossary text or
reproducible original-site fixtures and add positive, negative, edge, replay,
promotion, castling, and en-passant tests where relevant. Highest-value
empirical checks are:

1. Oddball and Even Keeled parity for both colors.
2. Forward March treatment of lateral moves, knights, and castling.
3. Eye for an Eye loss timing when no capture exists.
4. Battle Fatigue identity through promotion and castling.
5. Pacman activation by en-passant and capturing promotion.
6. The shared outcome when filtering removes every ordinary legal move.
7. False Prophets behavior for transformed pieces and combined drawbacks.
