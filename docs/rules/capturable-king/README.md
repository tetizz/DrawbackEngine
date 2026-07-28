# Capturable-king rules, v3 authority scope

Last reviewed: 2026-07-25

This wave implements five authority-complete observed drawbacks whose defining
semantics include a move that does not exist under orthodox chess: literal
capture of the opposing king. Every authority-scoped rule object is
scoped to `capturable-king/v1` and remains `implemented-unverified`. Community
wording and the pinned InvalidSE/DrawbackDetector observations corroborate the
displayed text, but neither source is an official executable specification.

The player-private authority catalog also includes the 20 rules from the
initial implementation milestone. Their capturable-king compatibility audit is
specified separately in
[`initial-milestone-compatibility.md`](initial-milestone-compatibility.md).
Together these two audited groups currently expose 25 labels to simulation and
symbolic opponent reconstruction.

An additional stateless compatibility audit prepares 12 existing standard
rules for the same authority. They are available only through the opt-in
37-label engine registry; the player-private v2 trace, simulator, and model
vocabulary remain frozen at 25 until a separately versioned migration. See
[`stateless-compatibility-wave.md`](stateless-compatibility-wave.md) for the
exact rule order, edge semantics, and unresolved ambiguities.

The machine-readable rules live in
`data/catalog/capturable-king-drawbacks-v3.json`. The authority-scoped objects
are intentionally not added to the frozen 182-class standard-authority v2
registry or model vocabulary. The canonical `irresistible` ID already has a
distinct `partial` standard-authority object in that frozen registry; its v3
object completes only the literal king-capture exception. The other four IDs
remain standard-catalog `unsupported`. A later authority-aware corpus/model
migration must version the label order and symbolic feature schema before
these objects enter a learned release.

All five rules use only the shared `DrawbackRule` filter, transition, and loss
contracts. The session remains the sole board authority and gives an actual
king capture immediate terminal precedence.

<!-- drawback-evidence:femme-fatale:specification -->
## Femme Fatale

Observed text: “You can only capture their king with a queen.”

The filter preserves every authority move except a literal opposing-king
capture whose primary pre-move piece type is not `queen`. It does not equate
check, checkmate, or SAN `+`/`#` with capture. A pawn that promotes while
capturing the king is still the primary pawn mover and is rejected. A queen
created on an earlier completed promotion is a queen and may capture the king.
Ordinary queen captures remain legal.

The source does not separately specify the authority's one-reply
castling-en-passant king capture. That move still has `captured: "king"` and is
therefore subject to the same primary-queen requirement. The integration suite
creates the special right by executing a castle, proves a rook capture is
filtered, and proves the same generated capture by a queen terminates with the
`castling-en-passant` method.

<!-- drawback-evidence:nurturer:specification -->
## Nurturer

Observed text: “You can't capture their king until you've promoted a pawn.”

State stores whether an affected-player pawn has completed any promotion. Both
quiet and capturing promotions to knight, bishop, rook, or queen unlock the
rule permanently. Opponent promotions do not unlock it, and later loss of the
promoted piece does not reset it. A pawn capture-promotion of the king cannot
satisfy its own prerequisite because the promotion has not completed before
the terminal move is filtered.

Initialization reconstructs only promotions present in the supplied affected
player's public move history. A promoted-looking piece in an arbitrary FEN is
not evidence that the affected player promoted it. Resuming a midgame without
complete history therefore fails closed with the king capture still locked;
persisted session rule state is the exact resume mechanism.

<!-- drawback-evidence:triple-play:specification -->
## Triple Play

Observed text: “You can only capture their king if you have three (random
piece).”

The pinned site-observation corpus contains five `knight` and two `bishop`
parameter texts. No other domain value is evidenced, so parameter generation
is deliberately restricted to those two types. It is not valid to infer pawn,
rook, queen, or king from the phrase “random piece.”

“Have three” is provisionally interpreted as at least three. Material is
counted on the affected player's pre-move board. Promoted pieces count by their
current type. Consequently, a pawn cannot become the third required bishop or
knight during the same king-capture promotion. Exactly-versus-at-least and
pre-move-versus-resulting material remain source-site verification questions.

<!-- drawback-evidence:irresistible:specification -->
## Irresistible

Observed text: “If you can move a piece adjacent to your opponent's king that
isn't already, you must, except that you are always permitted to capture their
king.”

The capturable and standard rule objects call the same filtering predicate. It
first finds every authority move whose primary mover starts non-adjacent and
ends adjacent to the present opposing king. If that set is nonempty, only
those moves plus literal opposing-king captures remain. If it is empty, the
turn is unrestricted. A piece that starts adjacent cannot satisfy the forced
set merely by moving to another adjacent square.

Promotion and en-passant use the primary pawn endpoints. Castling uses the
primary king endpoints rather than the auxiliary rook. Direct and
castling-en-passant king captures are unconditional exceptions and terminate
immediately when applied. Integration coverage creates both capture methods
from real authority state, including the transient right created by an
opponent castle.

The frozen standard-authority `irresistibleRule` stays `partial` because
orthodox legality cannot generate either literal capture exception. The
distinct `capturableKingIrresistibleRule` is `implemented-unverified` and does
not change the prepared 182-rule label order. Source-site replay is still
required to verify primary-versus-auxiliary castling semantics and the
authority's castling-en-passant exception.

<!-- drawback-evidence:you-best-not-miss:specification -->
## You Best Not Miss

Observed text: “If you end your turn checking your opponent, you must capture
their king on the next move (or lose).”

After every affected-player move, the transition checks the resulting board's
geometric attack state against the still-present opponent king. Quiet,
capturing, discovered, promotion, castling, and en-passant checks all arm the
obligation. SAN text is not consulted. An actual king capture is already
terminal and does not arm another obligation.

The flag persists across the opponent reply. At the affected player's next
turn, the filter retains only literal king captures. If the opponent has
removed all such replies, the immutable filter returns an empty set and
`DrawbackGameSession` adjudicates the drawback loss at the start of that turn.
This intentionally uses the authority-generated move set: FEN alone cannot
reconstruct the variant's castling-en-passant king-capture right.
Integration coverage arms the obligation with a real checking move, executes
the opponent's castle, verifies the generated king-passant capture remains
among the king-capture-only replies, and applies that reply as the terminal
move.

The wording strongly supports “next move” as the affected player's next turn,
but source-site replay is still required. It also does not say that only checks
guaranteed to remain capturable after the opponent reply trigger the rule, so
every check currently triggers. Arbitrary midgame initialization cannot
reconstruct a pre-reply check from final FEN plus move history and requires
persisted rule state.

## Verification status

Each rule has positive and negative filter tests, immutable-input and
both-color coverage, relevant promotion/castling/en-passant cases, a
machine-readable replay fixture, capturable-session terminal/loss tests, and
public authority replay/state tests. Those tests prove the documented
interpretation, not source-site equivalence. All five authority-scoped objects
remain
`implemented-unverified` until attributable site replays resolve their listed
ambiguities.
