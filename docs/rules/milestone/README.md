# First-milestone drawback specifications

These specifications turn the attributable wording collected in
`docs/research/remaining-milestone-rules.md` into explicit DrawbackEngine
behavior. The fifteen executable rules remain `implemented-unverified`.

Shared conventions: filter ordinary legal chess moves; classify en-passant and
capturing promotions as captures; classify promotion by the pre-move pawn and
castling by its primary king mover; use standard fullmove numbers for parity;
and interpret an affected player's “last move” as that player's previous turn.
White moves backwards to a lower rank and Black to a higher rank. Lateral moves
are not backwards.

## True Gentleman

Reject a move exactly when the captured target is a queen. Capturing promotion
onto a queen is forbidden. The moving type is irrelevant. Behavior for
transformed pieces and combined drawbacks is unknown.

## False Prophets

Reject captures whose primary mover is a bishop; permit quiet bishop moves and
captures by other types. The wording “Your bishops can't capture” is observed
twice in the InvalidSE/DrawbackDetector game corpus. Capturing promotion to a
bishop is a pawn move on that turn; later moves use the promoted bishop's
current type. The implementation remains unverified because the corpus is
observational rather than an official specification.

## Trophy Wife

Reject captures whose primary mover is a queen; permit quiet queen moves.
Capturing promotion to queen is a pawn move and is not rejected on that turn.
Whether transformed identity rather than current type controls the rule is
unknown.

## Cess

Reject moves whose primary destination is on the h-file. This includes captures
and promotions landing there. Secondary relocation and movement paths are not
tested because the source says only “move to.”

## Forward March

Reject moves whose destination rank is closer to the mover's home rank than its
origin. Permit forward and lateral moves. Promotions and en-passant advance;
castling is rank-neutral. Perspective, knight treatment, and secondary
castling relocation require original-game confirmation.

## Pacman

If an ordinary legal move captures a pawn, retain all and only pawn-capturing
moves. Otherwise leave the move set unchanged. En-passant and a promotion
capturing a pawn activate the rule. Pseudo-legal captures do not.

## Oddball and Even Keeled

Oddball rejects captures on even standard fullmove numbers. Even Keeled rejects
captures on odd standard fullmove numbers. Quiet moves remain legal.
En-passant and capturing promotions follow the same parity. The fullmove rather
than ply interpretation, particularly for Black, remains unverified.

## Quit Horsing Around

Record whether the affected player's previous primary mover was a knight. If
so, reject all knight moves on the next turn. A non-knight move clears the
state. Promotion to knight is a pawn move; castling is a king move.

## Remorseful

Record whether the affected player's previous move was a capture. If so, reject
all captures on the next turn. A non-capture clears the state. En-passant and
capturing promotions set it; quiet promotions and castling clear it. Empty-set
outcome behavior is not sourced.

## Battle Fatigue

Track physical pieces that capture. A fatigued piece may move without capture,
which clears its fatigue, but may not capture again first. Other pieces remain
independent. A capturing promotion carries fatigue to the promoted piece.
Persistent identity through promotion and castling remains unverified.

## Eye for an Eye

After the opponent captures, retain all and only ordinary legal captures on the
affected player's next turn. If none exists, record a start-of-turn drawback
loss because the wording expressly says “or lose.” Loss timing and unusual
simultaneous endings remain unverified.

## Barbarian Rage

After the affected player captures, require another capture on the next turn
when at least one ordinary legal capture exists. If none exists, leave all
ordinary legal moves available. The chosen move replaces the capture state.

## Conscientious Objectors

Reject captures whose primary mover is a pawn. En-passant and capturing
promotions are pawn captures and are rejected; quiet promotions are allowed.
Later moves use the promoted piece's current type.

## Horse Tranquilizer

Reject captures whose primary mover is a knight; permit quiet knight moves and
captures by other types. Capturing promotion to knight is a pawn move on that
turn. Later moves use the promoted knight's current type.

No rule may be promoted to `verified` until attributable evidence resolves its
listed uncertainties and positive, negative, edge, special-move, loss, and
replay tests pass where relevant.
