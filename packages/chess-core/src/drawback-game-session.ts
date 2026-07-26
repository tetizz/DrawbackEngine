import type {
  ChessMove,
  DrawbackLoss,
  DrawbackRule,
  PositionView,
  RuleRuntime,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor, RandomSource } from "@drawbackengine/shared";
import { opposite } from "@drawbackengine/shared";
import {
  CapturableKingPosition,
  type CapturableKingPositionSnapshot,
  type CapturableKingTerminal,
} from "./capturable-king-position.js";
import type {
  MoveCommand,
  RuleSecretSnapshot,
  SessionResult,
  SessionRules,
  SessionSecretSnapshot,
} from "./game-session.js";
import { sameMove } from "./move-adapter.js";
import {
  advancePublicGameTrace,
  createPublicGameTrace,
  inspectPublicGameTrace,
  type PublicGameTrace,
} from "./public-game-trace.js";

export interface DrawbackMoveObservation {
  readonly authorityId: "capturable-king/v1";
  readonly fenBefore: string;
  readonly fenAfter: string;
  readonly move: ChessMove;
  readonly authorityLegalMoves: readonly ChessMove[];
  readonly drawbackLegalMoves: readonly ChessMove[];
  readonly ruleTriggered: boolean;
  readonly forced: boolean;
  readonly orthodoxCompatibleAfter: boolean;
}

export interface DrawbackMoveAccepted {
  readonly ok: true;
  readonly observation: DrawbackMoveObservation;
  readonly result: SessionResult;
}

export interface DrawbackMoveRejected {
  readonly ok: false;
  readonly reason:
    | "game-over"
    | "not-authority-legal"
    | "drawback-forbidden";
  readonly message: string;
}

export type DrawbackMoveOutcome =
  | DrawbackMoveAccepted
  | DrawbackMoveRejected;

/**
 * Exact Drawback Chess session.
 *
 * Unlike GameSession's orthodox compatibility path, this session has no
 * checkmate or stalemate. It permits geometric chess moves that ignore check
 * and ends immediately on a direct or castling-en-passant king capture.
 */
export class DrawbackGameSession<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
> {
  public readonly knowledgeMode = "omniscient-oracle" as const;
  readonly #position: CapturableKingPosition;
  readonly #history: ChessMove[];
  #publicTrace: PublicGameTrace;
  #white: RuleRuntime<WhiteState, WhiteParameters>;
  #black: RuleRuntime<BlackState, BlackParameters>;
  #result: SessionResult;

  private constructor(
    position: CapturableKingPosition,
    history: readonly ChessMove[],
    publicTrace: PublicGameTrace,
    white: RuleRuntime<WhiteState, WhiteParameters>,
    black: RuleRuntime<BlackState, BlackParameters>,
    result: SessionResult,
  ) {
    this.#position = position;
    this.#history = structuredClone([...history]);
    this.#publicTrace = publicTrace;
    this.#white = cloneRuntime(white);
    this.#black = cloneRuntime(black);
    this.#result = structuredClone(result);
  }

  public static create<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters,
  >(
    rules: SessionRules<
      WhiteState,
      WhiteParameters,
      BlackState,
      BlackParameters
    >,
    rng: RandomSource,
    fen?: string,
  ): DrawbackGameSession<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters
  > {
    assertCapturableKingSupport(rules.white);
    assertCapturableKingSupport(rules.black);
    const position = CapturableKingPosition.fromFen(fen);
    const view: PositionView = {
      fen: position.fen,
      turn: position.turn,
      ply: 0,
      history: [],
    };
    const whiteParameters = rules.white.generateParameters(rng);
    const blackParameters = rules.black.generateParameters(rng);
    const session = new DrawbackGameSession(
      position,
      [],
      createPublicGameTrace(position.snapshot()),
      {
        rule: rules.white,
        parameters: whiteParameters,
        state: rules.white.initialize({
          color: "white",
          parameters: whiteParameters,
          position: view,
        }),
      },
      {
        rule: rules.black,
        parameters: blackParameters,
        state: rules.black.initialize({
          color: "black",
          parameters: blackParameters,
          position: view,
        }),
      },
      { kind: "active" },
    );
    session.#evaluateStartOfTurn();
    return session;
  }

  public get result(): SessionResult {
    return structuredClone(this.#result);
  }

  public get fen(): string {
    return this.#position.fen;
  }

  public get turn(): PlayerColor {
    return this.#position.turn;
  }

  public get orthodoxCompatible(): boolean {
    return this.#position.orthodoxCompatible;
  }

  /**
   * Complete public board-authority state. This contains no drawback rule,
   * parameters, internal rule state, or RNG.
   */
  public publicPositionSnapshot(): CapturableKingPositionSnapshot {
    return this.#position.snapshot();
  }

  public history(): readonly ChessMove[] {
    return structuredClone(this.#history);
  }

  /**
   * Authenticated complete public authority provenance. It contains no
   * drawback ID, parameters, rule state, RNG state, or secret labels.
   */
  public publicGameTrace(): PublicGameTrace {
    return this.#publicTrace;
  }

  public fork(): DrawbackGameSession<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters
  > {
    return new DrawbackGameSession(
      this.#position.clone(),
      this.#history,
      this.#publicTrace,
      this.#white,
      this.#black,
      this.#result,
    );
  }

  public exportSecretSnapshot(): SessionSecretSnapshot<
    WhiteParameters,
    WhiteState,
    BlackParameters,
    BlackState
  > {
    return structuredClone({
      white: secretSnapshot(this.#white),
      black: secretSnapshot(this.#black),
    });
  }

  public authorityLegalMoves(): readonly ChessMove[] {
    if (this.#result.kind !== "active") {
      return [];
    }
    return this.#position.legalMoves();
  }

  public legalMoves(): readonly ChessMove[] {
    if (this.#result.kind !== "active") {
      return [];
    }
    return this.#filterFor(this.turn, this.authorityLegalMoves());
  }

  public move(command: MoveCommand): DrawbackMoveOutcome {
    if (this.#result.kind !== "active") {
      return {
        ok: false,
        reason: "game-over",
        message: "The game has already ended.",
      };
    }
    const authorityLegalMoves = this.authorityLegalMoves();
    const requested = authorityLegalMoves.find((move) =>
      sameMove(command, move),
    );
    if (requested === undefined) {
      return {
        ok: false,
        reason: "not-authority-legal",
        message: `${command.from}-${command.to} is not a geometric Drawback Chess move.`,
      };
    }
    const drawbackLegalMoves = this.#filterFor(this.turn, authorityLegalMoves);
    if (!drawbackLegalMoves.some((move) => sameMove(requested, move))) {
      return {
        ok: false,
        reason: "drawback-forbidden",
        message: `${requested.san} is forbidden by the active drawback.`,
      };
    }

    const fenBefore = this.fen;
    const movingColor = this.turn;
    const positionBefore = this.#view();
    const applied = this.#position.move(command);
    if (applied === null) {
      throw new Error("Authority move disappeared between validation and application.");
    }
    this.#history.push(applied.move);
    const nextTrace = advancePublicGameTrace(
      this.#publicTrace,
      moveCommand(applied.move),
    );
    const traced = inspectPublicGameTrace(nextTrace);
    if (
      JSON.stringify(traced.current)
      !== JSON.stringify(this.#position.snapshot())
    ) {
      throw new Error(
        "Drawback session position diverged from its public game trace.",
      );
    }
    this.#publicTrace = nextTrace;
    this.#transitionRule(movingColor, applied.move, positionBefore);
    if (applied.terminal === null) {
      this.#evaluateStartOfTurn();
    } else {
      this.#applyTerminal(applied.terminal);
    }

    return {
      ok: true,
      observation: {
        authorityId: "capturable-king/v1",
        fenBefore,
        fenAfter: this.fen,
        move: applied.move,
        authorityLegalMoves,
        drawbackLegalMoves,
        ruleTriggered:
          drawbackLegalMoves.length !== authorityLegalMoves.length,
        forced: drawbackLegalMoves.length === 1,
        orthodoxCompatibleAfter: this.orthodoxCompatible,
      },
      result: this.result,
    };
  }

  #view(): PositionView {
    return {
      fen: this.fen,
      turn: this.turn,
      ply: this.#history.length,
      history: this.history(),
    };
  }

  #filterFor(
    color: PlayerColor,
    authorityMoves: readonly ChessMove[],
  ): readonly ChessMove[] {
    return color === "white"
      ? filterRuntime(
          this.#white,
          color,
          this.#view(),
          authorityMoves,
        )
      : filterRuntime(
          this.#black,
          color,
          this.#view(),
          authorityMoves,
        );
  }

  #transitionRule(
    color: PlayerColor,
    move: ChessMove,
    positionBefore: PositionView,
  ): void {
    if (color === "white") {
      this.#white = {
        ...this.#white,
        state: this.#white.rule.applyMove(
          {
            color,
            parameters: this.#white.parameters,
            state: this.#white.state,
            position: positionBefore,
            positionAfterMove: this.#view(),
          },
          move,
        ),
      };
      return;
    }
    this.#black = {
      ...this.#black,
      state: this.#black.rule.applyMove(
        {
          color,
          parameters: this.#black.parameters,
          state: this.#black.state,
          position: positionBefore,
          positionAfterMove: this.#view(),
        },
        move,
      ),
    };
  }

  #applyTerminal(terminal: CapturableKingTerminal): void {
    if (terminal === null) {
      return;
    }
    this.#result = {
      kind: "king-capture",
      winner: terminal.winner,
      capturedKing: terminal.capturedKing,
      method: terminal.method,
    };
  }

  #evaluateStartOfTurn(): void {
    const color = this.turn;
    const ruleLoss =
      color === "white"
        ? checkRuntimeLoss(this.#white, color, this.#view())
        : checkRuntimeLoss(this.#black, color, this.#view());
    if (ruleLoss !== null) {
      this.#result = { kind: "drawback-loss", loss: ruleLoss };
      return;
    }
    const authorityMoves = this.authorityLegalMoves();
    if (authorityMoves.length === 0) {
      this.#result = {
        kind: "no-legal-moves",
        winner: opposite(color),
        loser: color,
      };
      return;
    }
    if (this.#filterFor(color, authorityMoves).length === 0) {
      const ruleId =
        color === "white" ? this.#white.rule.id : this.#black.rule.id;
      this.#result = {
        kind: "drawback-loss",
        loss: {
          ruleId,
          color,
          reason: "The drawback forbids every geometric Drawback Chess move.",
        },
      };
    }
  }
}

function moveCommand(move: ChessMove): MoveCommand {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
}

function cloneRuntime<State, Parameters>(
  runtime: RuleRuntime<State, Parameters>,
): RuleRuntime<State, Parameters> {
  return {
    rule: runtime.rule,
    parameters: structuredClone(runtime.parameters),
    state: structuredClone(runtime.state),
  };
}

function secretSnapshot<State, Parameters>(
  runtime: RuleRuntime<State, Parameters>,
): RuleSecretSnapshot<Parameters, State> {
  return {
    drawbackId: runtime.rule.id,
    parameters: structuredClone(runtime.parameters),
    state: structuredClone(runtime.state),
  };
}

function filterRuntime<State, Parameters>(
  runtime: RuleRuntime<State, Parameters>,
  color: PlayerColor,
  position: PositionView,
  authorityMoves: readonly ChessMove[],
): readonly ChessMove[] {
  const filtered = runtime.rule.filterLegalMoves(
    {
      color,
      parameters: runtime.parameters,
      state: runtime.state,
      position,
    },
    structuredClone(authorityMoves),
  );
  const seen = new Set<string>();
  const validated: ChessMove[] = [];
  for (const move of filtered) {
    const source = authorityMoves.find((candidate) =>
      sameMove(candidate, move),
    );
    if (source === undefined) {
      throw new Error(
        `${runtime.rule.id} manufactured move ${move.from}-${move.to}; rules may only filter authority moves.`,
      );
    }
    const key = `${source.from}${source.to}${source.promotion ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      validated.push(source);
    }
  }
  return validated;
}

function checkRuntimeLoss<State, Parameters>(
  runtime: RuleRuntime<State, Parameters>,
  color: PlayerColor,
  position: PositionView,
): DrawbackLoss | null {
  return runtime.rule.checkStartOfTurnLoss({
    color,
    parameters: runtime.parameters,
    state: runtime.state,
    position,
  });
}

function assertCapturableKingSupport<State, Parameters>(
  rule: DrawbackRule<State, Parameters>,
): void {
  if (!rule.supportedAuthorities?.includes("capturable-king/v1")) {
    throw new Error(
      `${rule.id} has not been audited for capturable-king/v1 and cannot run in a DrawbackGameSession.`,
    );
  }
}
