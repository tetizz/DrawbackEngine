# Shared rule definitions

Unless a sourced rule specification says otherwise:

- “Piece” includes pawns.
- Adjacency includes orthogonal and diagonal neighbors.
- Distance is Manhattan distance.
- Piece values are pawn 1, knight 3, bishop 3, rook 5, queen 9; king is effectively infinite.
- The rim comprises files `a` and `h` and ranks `1` and `8`.
- Drawback loss conditions are evaluated at the beginning of the affected player's turn.

Ambiguities belong in the individual rule specification and force an `implemented-unverified` or lower status. The implementation must never silently choose an interpretation.
