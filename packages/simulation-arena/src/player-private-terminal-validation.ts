import {
  assertExactKeys,
  protocolRecord,
  type PlayerPrivateGameAssignment,
} from "./player-private-parallel-protocol.js";

export function validatePlayerPrivateTerminal(
  terminal: Record<string, unknown>,
  assignment: PlayerPrivateGameAssignment,
): void {
  if (terminal["kind"] === "active") {
    assertExactKeys(terminal, ["kind"], "active player-private result");
    return;
  }
  if (terminal["kind"] === "drawback-loss") {
    assertExactKeys(
      terminal,
      ["kind", "loss"],
      "drawback-loss player-private result",
    );
    const loss = protocolRecord(
      terminal["loss"],
      "player-private drawback loss",
    );
    assertExactKeys(
      loss,
      ["ruleId", "color", "reason"],
      "player-private drawback loss",
    );
    const color = loss["color"];
    const expectedRule =
      color === "white"
        ? assignment.whiteRuleId
        : color === "black"
          ? assignment.blackRuleId
          : null;
    if (
      expectedRule === null
      || loss["ruleId"] !== expectedRule
      || typeof loss["reason"] !== "string"
      || loss["reason"].length === 0
    ) {
      throw new TypeError("Player-private drawback loss is invalid.");
    }
    return;
  }
  if (terminal["kind"] === "king-capture") {
    assertExactKeys(
      terminal,
      ["kind", "winner", "capturedKing", "method"],
      "king-capture player-private result",
    );
    const winner = terminal["winner"];
    const captured = terminal["capturedKing"];
    if (
      (winner !== "white" && winner !== "black")
      || (captured !== "white" && captured !== "black")
      || winner === captured
      || (
        terminal["method"] !== "direct"
        && terminal["method"] !== "castling-en-passant"
      )
    ) {
      throw new TypeError("Player-private king-capture result is invalid.");
    }
    return;
  }
  if (terminal["kind"] === "no-legal-moves") {
    assertExactKeys(
      terminal,
      ["kind", "winner", "loser"],
      "no-legal-moves player-private result",
    );
    const winner = terminal["winner"];
    const loser = terminal["loser"];
    if (
      (winner !== "white" && winner !== "black")
      || (loser !== "white" && loser !== "black")
      || winner === loser
    ) {
      throw new TypeError("Player-private no-legal-moves result is invalid.");
    }
    return;
  }
  throw new TypeError("Player-private terminal result is invalid.");
}
