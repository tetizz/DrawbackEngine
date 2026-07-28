# Stateless capturable-king compatibility wave

Last reviewed: 2026-07-26

This audit extends 12 existing stateless move filters from
`standard-chess/v1` to `capturable-king/v1`. It does not change their
documented semantics or upgrade their `implemented-unverified` status.
Community descriptions and the pinned InvalidSE/DrawbackDetector corpus
support the interpretations below, but neither is an official executable
specification.

## Version boundary

The historical player-private ruleset v2 remains an immutable, ordered
25-label vocabulary. `AUDITED_CAPTURABLE_KING_RULE_IDS` continues to name that
tuple so existing traces, parsers, simulations, and models cannot silently
accept new labels.

The engine exposes the opt-in
`AUDITED_CAPTURABLE_KING_RULE_IDS_V3` tuple with those same 25 IDs followed by
the 12 rules in this document. The v3 tuple is an authority-compatibility
registry, not yet a training-data release. A player-private trace producer,
parser, simulator schedule, or learned model must declare a new ruleset/schema
and the exact 37-label order before using it.

## Shared authority contract

`DrawbackGameSession` asks the position authority for moves first, then gives
an immutable copy of that move set to the active drawback. Direct and
castling-en-passant king captures therefore pass through the same filters as
all other moves. A surviving king capture is terminal only after it is
applied; there is no implicit terminal exception to a drawback.

Mover type and endpoints are the primary pre-move piece and its `from`/`to`
squares. A promotion is a pawn move. Castling is a king move. En-passant uses
the pawn's landing square. Castling-en-passant uses the authority-generated
capturing piece and its endpoints.

## Rule interpretations and open ambiguities

### Far Sighted

Captures are forbidden when the origin and destination are adjacent by
Chebyshev distance; quiet moves are unrestricted. Orthogonal and diagonal
adjacency both count. En-passant is provisionally classified by the pawn's
landing square rather than the removed pawn's square because the source text
does not discuss the special move.

### Stop Stalling

Every move whose origin and destination share a rank is forbidden. Vertical,
diagonal, and knight moves with a rank change remain eligible. “Lateral” is
therefore interpreted as same-rank geometry, not any move with a horizontal
component. Both castling directions are lateral under the primary king
endpoints and are rejected.

### Whites of Their Eyes

Captures require Manhattan distance at most two; quiet moves are unrestricted.
The project-wide Manhattan definition is a defensible interpretation of
“distance,” but the observed text does not state a metric.

### Elephants Fear Mice

A pre-move non-pawn piece cannot capture a pawn. Pawns may capture pawns,
including en-passant. A capture-promotion is still a pawn move. The rule does
not create an exception or extra restriction for king targets.

### Control Center

Quiet moves must end on files `c`, `d`, `e`, or `f`; captures are exempt.
“Four central files” is interpreted as those files. Castling is classified by
the king destination, so queenside castling to `c` is eligible while kingside
castling to `g` is not.

### Indecisive

Capture choice is local to one physical piece, keyed by its source square. If
that piece has more than one authority-generated capture, all of its captures
are filtered while its quiet moves remain. Capture choices belonging to other
pieces do not interfere. Promotion choices are distinct moves, so four
capture-promotion choices to one destination currently count as four
capturing moves; the source wording does not resolve move-versus-destination
counting.

### Professional Courtesy

A non-pawn piece cannot capture an opposing non-pawn piece of the same
pre-move type. Pawn targets are exempt. This includes literal king-on-king
capture, which is rejected; a differently typed piece may capture the king.
A capture-promotion is classified as a pawn move.

### The Scent of Blood

An individual piece that has at least one authority-generated capture cannot
choose one of its quiet moves. Other pieces remain free to make quiet moves.
This is a local obligation, not a global forced-capture rule. A king-capture
opportunity suppresses quiet alternatives of that same mover.

### Champing at the Bit

Every pawn move must have Manhattan distance exactly two. This permits a
two-rank push and a one-file/one-rank diagonal capture, including en-passant,
while rejecting a single push. Promotion remains a pawn move, so quiet
one-rank promotion is rejected and diagonal capture-promotion is eligible.
This unusual result follows the observed distance wording and remains
source-site verification work.

### Shadow Queen

Every current queen must end on a dark square, with `a1` defined as dark.
Original and promoted queens are treated alike on later turns. A pawn
promoting to a queen is not a queen mover during that move. The source does
not distinguish the original queen from later queens.

### Stay at Home Mom

Every current queen must end on ranks 1 or 2 for White and ranks 7 or 8 for
Black. Promoted queens inherit the restriction on later turns, while the
promotion move itself remains a pawn move. “Home ranks” is interpreted
relative to the affected player's color.

### Snipers

A bishop capture requires Manhattan distance at least eight, equivalent to
four diagonal steps. Bishop quiet moves and moves by other pieces are
unrestricted. The explicit observed parenthetical “4 diagonal squares”
supports this conversion; promotion is classified by the pre-move pawn.

## Verification scope

Focused rule tests cover allowed and forbidden moves, immutable filtering,
both colors, direct king captures, promotion, castling, en-passant, and
move-set-dependent cases where relevant. A real
`CapturableKingPosition`/`DrawbackGameSession` integration suite covers
authority generation, rejection, and terminal king-capture behavior.

These tests verify the documented interpretations. Attributable source-site
replays are still required before any rule can become `verified`.
