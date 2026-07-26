# Third observed drawback batch

Last reviewed: 2026-07-24

These fifteen rules come from the Chess.com community glossary and the pinned
InvalidSE/DrawbackDetector observation corpus. They remain
`implemented-unverified`: the wording is attributable and reproducible, but no
official special-move specification is public.

## Move restrictions

- **Lucky:** ordinary chess with no additional restriction. It remains a
  distinct prediction label.
- **Eisoptrophobia:** reject captures when mover and captured current piece
  types match.
- **Gloomstalker:** reject captures whose origin is a light square; a1 is dark.
- **Noblesse Oblige:** kings and queens may capture only kings or queens.
- **Bongcloud:** while the affected king occupies rank 1 for White or rank 8
  for Black, only pawns and kings may move. Castling is a king move.
- **Eat Your Vegetables:** while the opponent has five or more pawns, reject
  captures of non-pawns. The restriction lifts at four.
- **Horse Eats First:** while the affected player has a knight, reject captures
  by non-knights.
- **Messy Divorce:** reject moves crossing between files a-d and e-h.
  Kingside castling remains within e-h; queenside castling crosses e-to-c and
  is rejected under this interpretation.

Promotion is classified by the pre-move pawn. Later turns use the promoted
piece's current type. En-passant is a pawn capture.

## Start-of-turn losses

- **Body Snatcher:** lose after the opponent's latest move captures a non-pawn
  with the same current piece type.
- **Castle Doctrine:** lose after the opponent has captured a rook.
- **My Kingdom for a Horse:** lose after the opponent has captured a knight.
- **Octomom:** lose after the opponent's eighth capture.
- **Pawn Battle:** lose while holding fewer current pawns than the opponent.
- **Edgelord:** lose while holding fewer pieces on the rim than the opponent.
  The rim is files a/h and ranks 1/8.
- **Botez Gambit:** at the start of the affected player's eleventh turn, lose
  unless they have no queen and the opponent has a queen. This is checked once,
  on standard FEN fullmove 11 for each color.

Capture-triggered losses are observed at the affected player's next
start-of-turn checkpoint. The symbolic predictor uses the same checkpoint
immediately after the opponent's move.
