# Initial milestone capturable-king compatibility

Last reviewed: 2026-07-26

The complete 20-rule initial milestone is executable under both
`standard-chess/v1` and `capturable-king/v1`. This authority audit does not
change any rule's `implemented-unverified` status. It proves that the
documented interpretation is enforced over the larger geometric move set; it
does not prove equivalence with the source site.

The audited labels are Vegan, True Gentleman, False Prophets, Trophy Wife,
Lame Duck, Cess, Forward March, Checkers, Pacman, Oddball, Even Keeled, Truant,
Spice of Life, Quit Horsing Around, Remorseful, Battle Fatigue, Eye for an Eye,
Barbarian Rage, Conscientious Objectors, and Horse Tranquilizer.

## Authority interaction contract

`DrawbackGameSession` generates authority moves first and gives an immutable
copy of that exact list to the active rule. A rule may filter but may not
manufacture a move. This makes literal direct and castling-en-passant king
captures ordinary filter inputs with `captured: "king"`.

- Capture-target rules distinguish a king from the piece types they forbid.
  True Gentleman therefore permits king capture but still forbids queen
  capture.
- Capture-mover rules apply to literal king capture. A bishop under False
  Prophets, queen under Trophy Wife, pawn under Conscientious Objectors, or
  knight under Horse Tranquilizer cannot bypass its drawback by ending the
  game.
- Forced-capture rules count a king capture as a capture. Checkers, Eye for an
  Eye, and an armed Barbarian Rage may require it. Pacman instead prefers an
  available pawn-target capture over a king capture because its observed rule
  specifically requires capturing a pawn.
- Destination, direction, and parity filters apply before terminal
  adjudication. Cess, Forward March, Oddball, and Even Keeled can therefore
  reject an otherwise terminal move.
- History restrictions also apply before terminal adjudication. Quit Horsing
  Around, Remorseful, and Battle Fatigue retain affected-player state across
  the opponent reply and can reject a king capture when their normal condition
  is active.
- Once a king-capture move survives the active filter and is applied, terminal
  adjudication takes precedence over later rule state or loss checks.

The primary mover controls all mover-type and movement-history rules.
Promotion captures use the pre-move pawn type. Castling uses the king as the
primary mover; its rook is auxiliary. Castling-en-passant king capture uses
the generated capturing piece as the primary mover.

## Evidence and remaining ambiguity

`capturable-king-milestone-rules.integration.test.ts` covers the full allowlist,
positive and negative direct king captures, all four promotion forms, both
parities, state retained across an opponent reply, forced terminal responses,
and queen/bishop castling-en-passant captures. Existing rule suites continue to
cover ordinary operation, castling, en-passant, promotion, immutability, and
color isolation where relevant.

The source descriptions do not explicitly discuss the site's
castling-en-passant king-capture extension, promotion captures of a king, or
whether a generally forbidden move receives a terminal exception. The
defensible implementation gives no implicit terminal exception: every
authority-generated move passes through the drawback first. All 20 rules
remain `implemented-unverified` until attributable source-site replays confirm
those edge semantics.
