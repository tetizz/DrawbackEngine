import { describe, expect, it } from "vitest";
import {
  gamblerRule,
  justPassingThroughRule,
  untitledDuckDrawbackRule,
  type DrawbackRule,
  type ParameterizedRuleState,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import { GameSession, type MoveCommand } from "./game-session.js";

const SEEDS = [0, 1, 17, 0xdeadbeef] as const;
const MAX_PLIES = 16;
const CI_TIMEOUT_MS = 15_000;

function moveKey(move: {
  readonly from: string;
  readonly to: string;
  readonly promotion?: string;
}): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

function command(move: {
  readonly from: string;
  readonly to: string;
  readonly promotion?: "knight" | "bishop" | "rook" | "queen";
}): MoveCommand {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
}

function createSession<Parameters>(
  rule: DrawbackRule<ParameterizedRuleState, Parameters>,
  seed: number,
): GameSession<
  ParameterizedRuleState,
  Parameters,
  ParameterizedRuleState,
  Parameters
> {
  return new GameSession({ white: rule, black: rule }, new Mulberry32(seed));
}

function expectDeterministicParameters<Parameters>(
  rule: DrawbackRule<ParameterizedRuleState, Parameters>,
): void {
  for (const seed of SEEDS) {
    const first = createSession(rule, seed).exportSecretSnapshot();
    const second = createSession(rule, seed).exportSecretSnapshot();
    expect(second).toEqual(first);
    expect(first.white.state).toEqual({ movesApplied: 0 });
    expect(first.black.state).toEqual({ movesApplied: 0 });
  }
}

function expectSnapshotIsolation<Parameters>(
  rule: DrawbackRule<ParameterizedRuleState, Parameters>,
): void {
  const session = createSession(rule, 20260723);
  const exported = session.exportSecretSnapshot();
  const mutableWhiteParameters = exported.white.parameters as unknown as Record<
    string,
    unknown
  >;
  const mutableWhiteState = exported.white.state as unknown as Record<
    string,
    unknown
  >;
  mutableWhiteParameters["injected"] = "not-live";
  mutableWhiteState["movesApplied"] = 999;

  const untouched = session.exportSecretSnapshot();
  expect(untouched.white.parameters).not.toHaveProperty("injected");
  expect(untouched.black.parameters).not.toHaveProperty("injected");
  expect(untouched.white.state).toEqual({ movesApplied: 0 });
  expect(untouched.black.state).toEqual({ movesApplied: 0 });

  const whiteMove = session.legalMoves()[0];
  expect(whiteMove).toBeDefined();
  if (whiteMove === undefined) {
    return;
  }
  expect(session.move(command(whiteMove)).ok).toBe(true);
  const afterWhite = session.exportSecretSnapshot();
  expect(afterWhite.white.state).toEqual({ movesApplied: 1 });
  expect(afterWhite.black.state).toEqual({ movesApplied: 0 });

  if (session.result.kind !== "active") {
    return;
  }
  const blackMove = session.legalMoves()[0];
  expect(blackMove).toBeDefined();
  if (blackMove === undefined) {
    return;
  }
  expect(session.move(command(blackMove)).ok).toBe(true);
  const afterBlack = session.exportSecretSnapshot();
  expect(afterBlack.white.state).toEqual({ movesApplied: 1 });
  expect(afterBlack.black.state).toEqual({ movesApplied: 1 });
}

function expectStandardLegalSubset<Parameters>(
  rule: DrawbackRule<ParameterizedRuleState, Parameters>,
): void {
  for (const seed of SEEDS) {
    const session = createSession(rule, seed);
    let plies = 0;
    while (session.result.kind === "active" && plies < MAX_PLIES) {
      const ordinary = new Set(session.ordinaryLegalMoves().map(moveKey));
      const drawbackLegal = session.legalMoves();
      expect(drawbackLegal.every((move) => ordinary.has(moveKey(move)))).toBe(true);
      expect(drawbackLegal).not.toBe(session.ordinaryLegalMoves());
      const selected = drawbackLegal[seed % drawbackLegal.length];
      if (selected === undefined) {
        break;
      }
      expect(session.move(command(selected)).ok).toBe(true);
      plies += 1;
    }
  }
}

describe("parameterized GameSession properties", () => {
  it(
    "generates identical per-color parameters and state for fixed seeds",
    () => {
      expectDeterministicParameters(untitledDuckDrawbackRule);
      expectDeterministicParameters(justPassingThroughRule);
      expectDeterministicParameters(gamblerRule);
    },
    CI_TIMEOUT_MS,
  );

  it(
    "keeps exported and live White/Black parameters and states isolated",
    () => {
      expectSnapshotIsolation(untitledDuckDrawbackRule);
      expectSnapshotIsolation(justPassingThroughRule);
      expectSnapshotIsolation(gamblerRule);
    },
    CI_TIMEOUT_MS,
  );

  it(
    "keeps every parameterized-rule move inside standard chess legality",
    () => {
      expectStandardLegalSubset(untitledDuckDrawbackRule);
      expectStandardLegalSubset(justPassingThroughRule);
      expectStandardLegalSubset(gamblerRule);
    },
    CI_TIMEOUT_MS,
  );
});
