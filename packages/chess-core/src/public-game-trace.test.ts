import { describe, expect, it } from "vitest";
import { unrestrictedRule } from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { CapturableKingPosition } from "./capturable-king-position.js";
import { DrawbackGameSession } from "./drawback-game-session.js";
import {
  advancePublicGameTrace,
  createPublicGameTrace,
  inspectPublicGameTrace,
  publicGameTraceView,
  replayPublicGameTrace,
} from "./public-game-trace.js";

const INITIAL_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("PublicGameTrace", () => {
  it("binds an explicit origin to complete canonical authority replay", () => {
    const origin = CapturableKingPosition.fromFen(INITIAL_FEN).snapshot();
    const first = advancePublicGameTrace(
      createPublicGameTrace(origin),
      { from: "e2", to: "e4" },
    );
    const complete = advancePublicGameTrace(
      first,
      { from: "e7", to: "e5" },
    );
    const snapshot = inspectPublicGameTrace(complete);
    const replayed = replayPublicGameTrace(
      origin,
      snapshot.moves,
      snapshot.current,
    );

    expect(inspectPublicGameTrace(replayed)).toEqual(snapshot);
    expect(publicGameTraceView(replayed)).toMatchObject({
      fen: snapshot.current.fen,
      turn: "white",
      ply: 2,
      history: snapshot.moves,
    });
  });

  it("does not trust structural copies or mutable inspection copies", () => {
    const trace = createPublicGameTrace(
      CapturableKingPosition.fromFen(INITIAL_FEN).snapshot(),
    );
    const forged = { ...trace };
    const inspected = inspectPublicGameTrace(trace);

    expect(() => inspectPublicGameTrace(forged as never)).toThrow(
      "was not minted",
    );
    expect(Object.isFrozen(inspected.origin)).toBe(true);
    expect(Object.isFrozen(inspected.current)).toBe(true);
    expect(Object.isFrozen(inspected.moves)).toBe(true);
    expect(inspectPublicGameTrace(trace).current.fen).toBe(INITIAL_FEN);
  });

  it("authenticates castling king-passant metadata", () => {
    const origin = CapturableKingPosition.fromFen(
      "5r1k/8/8/8/8/8/8/4K2R w K - 0 1",
    ).snapshot();
    const afterCastle = advancePublicGameTrace(
      createPublicGameTrace(origin),
      { from: "e1", to: "g1" },
    );
    const afterCapture = advancePublicGameTrace(
      afterCastle,
      { from: "f8", to: "f1" },
    );
    const data = inspectPublicGameTrace(afterCapture);

    expect(data.moves).toMatchObject([
      { from: "e1", to: "g1", flags: "quiet,kingside-castle" },
      {
        from: "f8",
        to: "f1",
        captured: "king",
        flags: "capture,king-en-passant",
      },
    ]);
    if (data.current.authorityId !== "capturable-king/v1") {
      throw new Error("Expected the capturable-king authority.");
    }
    expect(data.current.terminal).toMatchObject({
      kind: "king-capture",
      winner: "black",
      capturedKing: "white",
      method: "castling-en-passant",
    });
  });

  it("keeps parent and fork provenance isolated after either branch advances", () => {
    const parent = DrawbackGameSession.create(
      { white: unrestrictedRule, black: unrestrictedRule },
      new Mulberry32(41),
      INITIAL_FEN,
    );
    const child = parent.fork();
    const shared = parent.publicGameTrace();

    expect(child.publicGameTrace()).toBe(shared);
    expect(child.move({ from: "e2", to: "e4" })).toMatchObject({ ok: true });
    expect(parent.move({ from: "d2", to: "d4" })).toMatchObject({ ok: true });

    expect(inspectPublicGameTrace(shared).moves).toEqual([]);
    expect(inspectPublicGameTrace(child.publicGameTrace()).moves).toMatchObject(
      [{ from: "e2", to: "e4", color: "white" }],
    );
    expect(inspectPublicGameTrace(parent.publicGameTrace()).moves).toMatchObject(
      [{ from: "d2", to: "d4", color: "white" }],
    );
  });
});
