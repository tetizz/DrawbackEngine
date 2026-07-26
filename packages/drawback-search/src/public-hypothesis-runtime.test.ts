import { describe, expect, it } from "vitest";
import {
  CapturableKingPosition,
  advancePublicGameTrace,
  createPublicGameTrace,
  createStandardChessPositionSnapshot,
  inspectPublicGameTrace,
  publicAuthorityLegalMoves,
  publicGameTraceView,
  replayPublicGameTrace,
  type PublicGameTrace,
} from "@drawbackengine/chess-core";
import {
  capturableKingRules,
  triplePlayRule,
  youBestNotMissRule,
  type ChessMove,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";
import { createPublicDrawbackHypothesis } from "./player-private-capability.js";
import { PublicRuleStateReconstructionError } from "./player-private-capability.js";

const REGRESSION_FEN = "7k/8/8/8/8/8/8/R3K3 w - - 0 1";

describe("public hypothesis runtime boundaries", () => {
  it("rejects every non-canonical empty parameter shape", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const inherited: unknown = Object.create({ inherited: true });
    const nullPrototype: unknown = Object.create(null);
    const symbolKey = { [Symbol("unexpected")]: true };
    const hiddenKey = Object.defineProperty({}, "unexpected", {
      enumerable: false,
      value: true,
    });
    const accessor = Object.defineProperty({}, "unexpected", {
      enumerable: true,
      get: () => true,
    });
    const malformed: readonly unknown[] = [
      null,
      undefined,
      true,
      1,
      "parameters",
      [],
      sparse,
      { unexpected: true },
      inherited,
      nullPrototype,
      symbolKey,
      hiddenKey,
      accessor,
    ];
    const trace = createPublicGameTrace(
      CapturableKingPosition.fromFen().snapshot(),
    );
    const noParameterRules = capturableKingRules.filter(
      (rule) => rule.id !== "triple-play",
    );

    expect(noParameterRules).toHaveLength(4);
    for (const rule of noParameterRules) {
      expect(() => hypothesis(
        `${rule.id}/valid`,
        "black",
        rule,
        {},
        trace,
      )).not.toThrow();
      for (const [caseIndex, parameters] of malformed.entries()) {
        expect(
          () => hypothesis(
            `${rule.id}/malformed`,
            "black",
            rule,
            parameters,
            trace,
          ),
          `${rule.id} accepted malformed case ${String(caseIndex)}`,
        ).toThrow();
      }
    }
  });

  it("accepts exactly the two Triple Play particles", () => {
    const trace = createPublicGameTrace(
      CapturableKingPosition.fromFen().snapshot(),
    );
    for (const requiredType of ["bishop", "knight"] as const) {
      expect(() => hypothesis(
        `triple-play/${requiredType}`,
        "black",
        triplePlayRule,
        { requiredType },
        trace,
      )).not.toThrow();
    }

    const sparse: unknown[] = [];
    sparse.length = 1;
    const inherited: unknown = Object.create({ requiredType: "bishop" });
    const nullPrototype: unknown = Object.assign(Object.create(null), {
      requiredType: "bishop",
    });
    const symbolKey = {
      requiredType: "bishop",
      [Symbol("unexpected")]: true,
    };
    const hiddenRequired = Object.defineProperty({}, "requiredType", {
      enumerable: false,
      value: "bishop",
    });
    let accessorRead = false;
    const accessorRequired = Object.defineProperty({}, "requiredType", {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return "bishop";
      },
    });
    const malformed: readonly unknown[] = [
      null,
      [],
      sparse,
      {},
      { requiredType: "pawn" },
      { requiredType: "BISHOP" },
      { requiredType: "bishop", unexpected: true },
      inherited,
      nullPrototype,
      symbolKey,
      hiddenRequired,
      accessorRequired,
    ];
    for (const parameters of malformed) {
      expect(() => hypothesis(
        "triple-play/malformed",
        "black",
        triplePlayRule,
        parameters,
        trace,
      )).toThrow();
    }
    expect(accessorRead).toBe(false);
  });

  it("distinguishes an explicit custom origin from the same later FEN", () => {
    const origin = CapturableKingPosition.fromFen(REGRESSION_FEN).snapshot();
    const initialTrace = createPublicGameTrace(origin);
    const afterCheck = advancePublicGameTrace(
      initialTrace,
      { from: "a1", to: "a8" },
    );
    const authenticTrace = advancePublicGameTrace(
      afterCheck,
      { from: "h8", to: "g7" },
    );
    const current = inspectPublicGameTrace(authenticTrace).current;
    const customOriginTrace = createPublicGameTrace(current);
    const authentic = hypothesis(
      "you-best-not-miss/authentic",
      "white",
      youBestNotMissRule,
      {},
      authenticTrace,
    );
    const explicitCustomOrigin = hypothesis(
      "you-best-not-miss/custom-origin",
      "white",
      youBestNotMissRule,
      {},
      customOriginTrace,
    );
    const position = publicGameTraceView(authenticTrace);
    const authorityMoves = publicAuthorityLegalMoves(current);

    expect(authentic.capability.legalMoves(position, authorityMoves)).toEqual(
      [],
    );
    expect(
      explicitCustomOrigin.capability.legalMoves(
        publicGameTraceView(customOriginTrace),
        authorityMoves,
      ),
    ).toEqual(authorityMoves);
    expect(inspectPublicGameTrace(authenticTrace)).toMatchObject({
      origin,
      current,
      moves: [{ from: "a1", to: "a8" }, { from: "h8", to: "g7" }],
    });
    expect(inspectPublicGameTrace(customOriginTrace)).toMatchObject({
      origin: current,
      current,
      moves: [],
    });
  });

  it("rejects forged, altered, truncated, and reordered provenance", () => {
    const origin = CapturableKingPosition.fromFen(REGRESSION_FEN).snapshot();
    const traceAfterCheck = advancePublicGameTrace(
      createPublicGameTrace(origin),
      { from: "a1", to: "a8" },
    );
    const completeTrace = advancePublicGameTrace(
      traceAfterCheck,
      { from: "h8", to: "g7" },
    );
    const complete = inspectPublicGameTrace(completeTrace);
    const forged = { ...completeTrace };

    expect(() => hypothesis(
      "forged",
      "white",
      youBestNotMissRule,
      {},
      forged as never,
    )).toThrow("was not minted");

    const altered = complete.moves.map((move, index) =>
      index === 0 ? { ...move, san: "Ra7" } : move
    );
    expect(() =>
      replayPublicGameTrace(origin, altered, complete.current)
    ).toThrow("does not match authority replay");

    expect(() =>
      replayPublicGameTrace(
        origin,
        complete.moves.slice(0, 1),
        complete.current,
      )
    ).toThrow("does not match the expected current snapshot");

    expect(() =>
      replayPublicGameTrace(
        origin,
        [...complete.moves].reverse(),
        complete.current,
      )
    ).toThrow();

    const fakeFlags = complete.moves.map((move, index) =>
      index === 0 ? { ...move, flags: `${move.flags}c` } : move
    );
    expect(() =>
      replayPublicGameTrace(origin, fakeFlags, complete.current)
    ).toThrow("does not match authority replay");
  });

  it("carries the exact Ra1-a8+ ...Kh8-g7 obligation generically", () => {
    const origin = CapturableKingPosition.fromFen(REGRESSION_FEN).snapshot();
    const initialTrace = createPublicGameTrace(origin);
    const initial = hypothesis(
      "you-best-not-miss/carried",
      "white",
      youBestNotMissRule,
      {},
      initialTrace,
    );
    const afterCheckTrace = advancePublicGameTrace(
      initialTrace,
      { from: "a1", to: "a8" },
    );
    const afterCheckData = inspectPublicGameTrace(afterCheckTrace);
    const afterCheck = publicGameTraceView(afterCheckTrace);
    const armed = initial.capability.applyMove(
      publicGameTraceView(initialTrace),
      afterCheck,
      requiredTraceMove(afterCheckData.moves, 0),
    );
    const afterReplyTrace = advancePublicGameTrace(
      afterCheckTrace,
      { from: "h8", to: "g7" },
    );
    const afterReplyData = inspectPublicGameTrace(afterReplyTrace);
    const afterReply = publicGameTraceView(afterReplyTrace);
    const carried = armed.applyMove(
      afterCheck,
      afterReply,
      requiredTraceMove(afterReplyData.moves, 1),
    );
    const reconstructed = hypothesis(
      "you-best-not-miss/reconstructed",
      "white",
      youBestNotMissRule,
      {},
      afterReplyTrace,
    );
    const authorityMoves = publicAuthorityLegalMoves(afterReplyData.current);

    expect(carried.legalMoves(afterReply, authorityMoves)).toEqual([]);
    expect(reconstructed.capability.legalMoves(
      afterReply,
      authorityMoves,
    )).toEqual([]);
  });

  it("validates authority before replaying a public hypothesis", () => {
    const trace = createPublicGameTrace(
      createStandardChessPositionSnapshot(
        "8/8/8/8/8/8/4k3/4K3 w - - 0 1",
      ),
    );
    expect(() =>
      createPublicDrawbackHypothesis(
        "you-best-not-miss/wrong-authority",
        1,
        "black",
        youBestNotMissRule,
        {},
        trace,
      )
    ).toThrow("has not been audited for standard-chess/v1");
  });

  it("keeps White and Black replay state isolated", () => {
    const initialTrace = createPublicGameTrace(
      CapturableKingPosition.fromFen(REGRESSION_FEN).snapshot(),
    );
    const white = hypothesis(
      "you-best-not-miss/white",
      "white",
      youBestNotMissRule,
      {},
      initialTrace,
    );
    const black = hypothesis(
      "you-best-not-miss/black",
      "black",
      youBestNotMissRule,
      {},
      initialTrace,
    );
    const afterCheckTrace = advancePublicGameTrace(
      initialTrace,
      { from: "a1", to: "a8" },
    );
    const afterCheckData = inspectPublicGameTrace(afterCheckTrace);
    const afterCheck = publicGameTraceView(afterCheckTrace);
    const initial = publicGameTraceView(initialTrace);
    const move = requiredTraceMove(afterCheckData.moves, 0);
    const armedWhite = white.capability.applyMove(initial, afterCheck, move);
    const clearBlack = black.capability.applyMove(initial, afterCheck, move);
    const afterReplyTrace = advancePublicGameTrace(
      afterCheckTrace,
      { from: "h8", to: "g7" },
    );
    const afterReplyData = inspectPublicGameTrace(afterReplyTrace);
    const afterReply = publicGameTraceView(afterReplyTrace);
    const reply = requiredTraceMove(afterReplyData.moves, 1);
    const carriedWhite = armedWhite.applyMove(afterCheck, afterReply, reply);
    const carriedBlack = clearBlack.applyMove(afterCheck, afterReply, reply);
    const authorityMoves = publicAuthorityLegalMoves(afterReplyData.current);

    expect(carriedWhite.legalMoves(afterReply, authorityMoves)).toEqual([]);
    expect(carriedBlack.legalMoves(afterReply, authorityMoves)).toEqual(
      authorityMoves,
    );
  });

  it("fails closed when authenticated play contradicts a hypothesis loss", () => {
    const initialTrace = createPublicGameTrace(
      CapturableKingPosition.fromFen(REGRESSION_FEN).snapshot(),
    );
    const afterCheck = advancePublicGameTrace(
      initialTrace,
      { from: "a1", to: "a8" },
    );
    const afterReply = advancePublicGameTrace(
      afterCheck,
      { from: "h8", to: "g7" },
    );
    const afterIllegalContinuation = advancePublicGameTrace(
      afterReply,
      { from: "a8", to: "a7" },
    );

    expect(() => hypothesis(
      "you-best-not-miss/contradicted",
      "white",
      youBestNotMissRule,
      {},
      afterIllegalContinuation,
    )).toThrowError(PublicRuleStateReconstructionError);
    try {
      hypothesis(
        "you-best-not-miss/contradicted",
        "white",
        youBestNotMissRule,
        {},
        afterIllegalContinuation,
      );
      throw new Error("Expected public reconstruction to fail.");
    } catch (error: unknown) {
      expect(error).toMatchObject({
        name: "PublicRuleStateReconstructionError",
        authorityId: "capturable-king/v1",
        color: "white",
        drawbackId: "you-best-not-miss",
      });
    }
  });
});

function hypothesis(
  hypothesisId: string,
  color: PlayerColor,
  rule: (typeof capturableKingRules)[number],
  parameters: unknown,
  trace: PublicGameTrace,
) {
  return createPublicDrawbackHypothesis(
    hypothesisId,
    1,
    color,
    rule,
    // The test intentionally crosses the statically typed boundary with
    // serialized unknown input to exercise each rule's runtime parser.
    parameters as never,
    trace,
  );
}

function requiredTraceMove(
  moves: readonly ChessMove[],
  index: number,
): ChessMove {
  const move = moves[index];
  if (move === undefined) {
    throw new Error(`Expected authenticated trace move ${String(index)}.`);
  }
  return move;
}
