import { parseFen } from "chessops/fen";
import type { Role } from "chessops/types";
import type { DrawbackLeafEvaluator } from "./types.js";

const VALUES: Readonly<Record<Role, number>> = {
  pawn: 100,
  knight: 320,
  bishop: 330,
  rook: 500,
  queen: 900,
  king: 0,
};

export const drawbackMaterialEvaluator: DrawbackLeafEvaluator = {
  id: "drawback-material/v1",
  evaluate(position) {
    const setup = parseFen(position.fen).unwrap();
    let white = 0;
    let black = 0;
    for (const square of setup.board.occupied) {
      const piece = setup.board.get(square);
      if (piece === undefined) {
        continue;
      }
      if (piece.color === "white") {
        white += VALUES[piece.role];
      } else {
        black += VALUES[piece.role];
      }
    }
    const whitePerspective = white - black;
    return Promise.resolve(
      position.turn === "white" ? whitePerspective : -whitePerspective,
    );
  },
};
