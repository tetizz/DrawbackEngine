import {
  DrawbackGameSession,
} from "@drawbackengine/chess-core";
import {
  canonicalMoveUci,
  resolveAuditedCapturableKingRule,
  type ChessMove,
  type PromotionPiece,
} from "@drawbackengine/drawback-engine";
import {
  Mulberry32,
} from "@drawbackengine/shared";
import type {
  PlayerPrivateSimulationTraceRecord,
  TraceRuleSecret,
} from "./player-private-types.js";
import { jsonValueAt } from "./parse-primitives.js";

const UCI_PROMOTION: Readonly<Record<string, PromotionPiece>> = {
  b: "bishop",
  n: "knight",
  q: "queen",
  r: "rook",
};

export function validatePlayerPrivateSemanticReplay(
  record: PlayerPrivateSimulationTraceRecord,
): void {
  const whiteRule = resolveAuditedCapturableKingRule(
    record.secrets.initial.white.drawbackId,
  );
  const blackRule = resolveAuditedCapturableKingRule(
    record.secrets.initial.black.drawbackId,
  );
  const session = DrawbackGameSession.create(
    { white: whiteRule, black: blackRule },
    {
      white: new Mulberry32(record.parameterSeeds.white),
      black: new Mulberry32(record.parameterSeeds.black),
    },
    record.initialPosition.fen,
  );
  assertEqual(
    session.publicPositionSnapshot(),
    record.initialPosition,
    "trace.initialPosition does not match a fresh authority session.",
  );
  assertSessionSecrets(
    session.exportSecretSnapshot(),
    record.secrets.initial,
    "trace.secrets.initial",
  );

  for (const [index, ply] of record.plies.entries()) {
    const path = `trace.plies[${String(index)}]`;
    if (session.result.kind !== "active") {
      throw new TypeError(`${path} occurs after the exact game result.`);
    }
    if (session.turn !== ply.color) {
      throw new TypeError(`${path}.color does not match exact replay.`);
    }
    assertEqual(
      session.publicPositionSnapshot(),
      ply.positionBefore,
      `${path}.positionBefore does not match exact replay.`,
    );
    const activeSecret =
      ply.color === "white"
        ? session.exportSecretSnapshot().white
        : session.exportSecretSnapshot().black;
    assertRuleSecret(
      activeSecret,
      ply.activeSecret,
      `${path}.activeSecret`,
    );
    assertMoveSet(
      session.authorityLegalMoves(),
      ply.authorityLegalMoves,
      `${path}.authorityLegalMoves`,
    );
    assertMoveSet(
      session.legalMoves(),
      ply.drawbackLegalMoves,
      `${path}.drawbackLegalMoves`,
    );
    const outcome = session.move(commandFromUci(ply.move.uci));
    if (!outcome.ok) {
      throw new TypeError(
        `${path}.move is rejected by exact replay: ${outcome.reason}.`,
      );
    }
    if (
      canonicalMoveUci(outcome.observation.move) !== ply.move.uci
      || outcome.observation.move.san !== ply.move.san
    ) {
      throw new TypeError(`${path}.move does not match exact replay.`);
    }
    if (
      outcome.observation.ruleTriggered !== ply.ruleTriggered
      || outcome.observation.forced !== ply.forced
    ) {
      throw new TypeError(
        `${path} trigger or forced label does not match exact replay.`,
      );
    }
    assertEqual(
      session.publicPositionSnapshot(),
      ply.positionAfter,
      `${path}.positionAfter does not match exact replay.`,
    );
  }

  assertEqual(
    session.publicPositionSnapshot(),
    record.finalPosition,
    "trace.finalPosition does not match exact replay.",
  );
  assertSessionSecrets(
    session.exportSecretSnapshot(),
    record.secrets.final,
    "trace.secrets.final",
  );
  assertEqual(
    session.result,
    record.result,
    "trace.result does not match exact replay.",
  );
}

function assertMoveSet(
  actualMoves: readonly ChessMove[],
  expectedUci: readonly string[],
  path: string,
): void {
  const actualUci = actualMoves.map(canonicalMoveUci).sort();
  if (
    actualUci.length !== expectedUci.length
    || actualUci.some((move, index) => move !== expectedUci[index])
  ) {
    throw new TypeError(`${path} is not the complete exact legal set.`);
  }
}

function assertSessionSecrets(
  actual: {
    readonly white: {
      readonly drawbackId: string;
      readonly parameters: unknown;
      readonly state: unknown;
    };
    readonly black: {
      readonly drawbackId: string;
      readonly parameters: unknown;
      readonly state: unknown;
    };
  },
  expected: {
    readonly white: TraceRuleSecret;
    readonly black: TraceRuleSecret;
  },
  path: string,
): void {
  assertRuleSecret(actual.white, expected.white, `${path}.white`);
  assertRuleSecret(actual.black, expected.black, `${path}.black`);
}

function assertRuleSecret(
  actual: {
    readonly drawbackId: string;
    readonly parameters: unknown;
    readonly state: unknown;
  },
  expected: TraceRuleSecret,
  path: string,
): void {
  if (actual.drawbackId !== expected.drawbackId) {
    throw new TypeError(`${path}.drawbackId does not match exact replay.`);
  }
  assertEqual(
    actual.parameters,
    expected.hiddenParameters,
    `${path}.hiddenParameters does not match exact replay.`,
  );
  assertEqual(
    actual.state,
    expected.drawbackInternalState,
    `${path}.drawbackInternalState does not match exact replay.`,
  );
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const actualCanonical =
    JSON.stringify(jsonValueAt(actual, "replay.actual"));
  const expectedCanonical =
    JSON.stringify(jsonValueAt(expected, "replay.expected"));
  if (
    actualCanonical !== expectedCanonical
  ) {
    throw new TypeError(message);
  }
}

function commandFromUci(uci: string): {
  readonly from: string;
  readonly to: string;
  readonly promotion?: PromotionPiece;
} {
  const promotionSymbol = uci[4];
  const promotion =
    promotionSymbol === undefined ? undefined : UCI_PROMOTION[promotionSymbol];
  if (promotionSymbol !== undefined && promotion === undefined) {
    throw new TypeError(`Unsupported UCI promotion symbol: ${promotionSymbol}.`);
  }
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(promotion === undefined ? {} : { promotion }),
  };
}
