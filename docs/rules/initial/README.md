# Initial drawback rules

All five rules in this milestone are `implemented-unverified`. Their core
wording is publicly attributable, but the original game does not expose a
complete executable specification for special moves and empty filtered move
sets. The conventions below are therefore explicit DrawbackEngine
interpretations, based on `docs/research/initial-rule-evidence.md`.

## Shared conventions

- The engine filters only moves already legal under standard chess.
- Capture classification includes en-passant and capturing promotions.
- Promotion is classified by the moving pawn's pre-move type.
- Castling's primary mover is the king; its rook is a secondary relocation.
- An empty filtered set is returned to the game-session policy. These rules do
  not invent a loss condition.
- None of these rules has hidden parameters or a start-of-turn loss.

## Vegan

Forbid a move exactly when its captured target is an opposing knight. A knight
may move or capture, and non-capturing knight moves remain legal. Capturing
promotion onto a knight is forbidden. En-passant and castling are unaffected
under standard chess.

Ambiguity: transformed pieces and interactions with other drawbacks have no
publicly documented behavior.

## Lame Duck

Forbid every move whose primary mover is the king. This includes king captures
and both forms of castling.

Ambiguity: public sources do not specify the outcome when check can only be
answered by a king move, or whether the original game changes ordinary check
semantics.

## Checkers

When one or more ordinary legal captures exist, retain all and only those
captures. Otherwise retain every ordinary legal move. Legal en-passant and
capturing-promotion moves activate the rule; pseudo-legal captures do not.

Ambiguity: the source does not explicitly distinguish legal from pseudo-legal
"able" captures or define composition with another rule that blocks captures.

## Truant

Record the destination of the affected player's previous primary mover and
forbid that piece from moving on the player's next turn. The opponent's
intervening move does not reset this state. Different pieces of the same type
remain legal. A promoted pawn retains physical identity, and castling records
only the king at its destination.

The destination is sufficient for this one-turn restriction: before the
affected player's next turn, no other friendly piece can replace it there. If
the opponent captures it, no legal affected-player move can originate from the
square.

Ambiguity: the source does not define persistent identity, setup positions,
promotion, castling, or the outcome when only the repeated piece can move.

## Spice of Life

Record the pre-move type of the affected player's previous primary mover and
forbid all moves by that type on the player's next turn. Thus moving one knight
blocks both knights. A promoting move records pawn, while a later move by the
promoted piece uses its new type. Castling records king only.

Ambiguity: the original behavior for resulting promotion type, castling's rook,
transformed pieces, and empty filtered sets is undocumented.

## Verification promotion

Do not promote a rule to `verified` until official text or reproducible
original-site observations resolve its listed ambiguities and the resulting
behavior is covered by positive, negative, special-move, empty-set, and replay
tests as applicable.

## Audited implementation evidence

`packages/drawback-engine/src/rules/initial-rules.test.ts` records focused
positive, negative, edge, promotion, castling, en-passant, and rule-local loss
applicability cases. `packages/chess-core/src/initial-rule-replays.test.ts`
loads each JSON replay, applies its normal moves through `GameSession`, proves
every declared probe is standard-chess legal, and then verifies the drawback
permits or rejects it as declared.

Special-move applicability is interpreted narrowly:

- Vegan examines the captured target, so capturing promotion is directly
  relevant; ordinary promotion, castling, and en-passant are exercised as
  unaffected cases.
- Lame Duck examines the primary mover. Castling is directly relevant because
  its primary mover is the king; pawn promotion and en-passant are exercised
  as unaffected non-king cases.
- Checkers examines whether any ordinary legal move is a capture. Capturing
  promotion and en-passant activate it; quiet promotion and castling do not.
- Truant tracks the primary mover at its landing square. Promotion,
  en-passant, and castling are exercised because each changes or relocates a
  piece while the rule records physical-mover identity.
- Spice of Life records the primary mover's pre-move type. Promotion,
  en-passant, and castling are exercised to make that classification explicit.

Start-of-turn loss is not part of any of these five rule contracts:
`checkStartOfTurnLoss` returns `null`. An empty filtered move set is tested
separately and is handled by the game session's general no-drawback-legal-move
policy. That engine convention is not evidence of the original site's
undocumented outcome.

This audit strengthens implementation evidence but does not resolve the source
ambiguities above. All five therefore remain `implemented-unverified`.
