import { Chess } from "chess.js";
import { createEvaluatorTurnConstraintRequest } from "@drawbackengine/drawback-engine";
import type {
  ChessMove,
  DrawbackLoss,
  DrawbackRule,
  ExternalConstraintDrawbackRule,
  ExternalTurnConstraint,
  ExternalTurnConstraintProvider,
  PositionView,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";
import { opposite } from "@drawbackengine/shared";
import {
  type MoveAccepted,
  type MoveCommand,
  type MoveOutcome,
  type RuleSecretSnapshot,
  type SessionResult,
} from "./game-session.js";
import { playerColor, sameMove, toChessMove } from "./move-adapter.js";
import {
  resolveSessionParameterRandomSources,
  type SessionParameterRandomInput,
} from "./session-random.js";

export type PreparedSessionRule<State, Parameters> =
  | DrawbackRule<State, Parameters>
  | ExternalConstraintDrawbackRule<State, Parameters>;

export interface PreparedSessionRules<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
> {
  readonly white: PreparedSessionRule<WhiteState, WhiteParameters>;
  readonly black: PreparedSessionRule<BlackState, BlackParameters>;
}

export interface AsyncGameSessionOptions {
  readonly provider?: ExternalTurnConstraintProvider;
  readonly fen?: string;
}

interface PreparedRuntime<State, Parameters> {
  readonly rule: PreparedSessionRule<State, Parameters>;
  readonly parameters: Readonly<Parameters>;
  readonly state: Readonly<State>;
}

interface PreparedTurn {
  readonly revision: number;
  readonly ordinaryLegalMoves: readonly ChessMove[];
  readonly drawbackLegalMoves: readonly ChessMove[];
  readonly externalConstraint?: ExternalTurnConstraint;
}

const PROMOTION_SYMBOL = {
  knight: "n",
  bishop: "b",
  rook: "r",
  queen: "q",
} as const;

function isExternalRule<State, Parameters>(
  rule: PreparedSessionRule<State, Parameters>,
): rule is ExternalConstraintDrawbackRule<State, Parameters> {
  return "kind" in rule;
}

export class AsyncSessionPreparationError extends Error {
  public constructor(
    message: string,
    public readonly moveApplied: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AsyncSessionPreparationError";
  }
}

/**
 * Prepared-turn session for games that may use evaluator-backed drawbacks.
 * Standard rules retain their synchronous pure filters; external facts are
 * resolved before a legal set is exposed and are never replaced by a fallback.
 */
export class AsyncGameSession<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
> {
  readonly #chess: Chess;
  readonly #history: ChessMove[] = [];
  readonly #provider: ExternalTurnConstraintProvider | undefined;
  #white: PreparedRuntime<WhiteState, WhiteParameters>;
  #black: PreparedRuntime<BlackState, BlackParameters>;
  #result: SessionResult = { kind: "active" };
  #revision = 0;
  #prepared: PreparedTurn | null = null;
  #preparing: Promise<void> | null = null;
  #pendingAccepted: MoveAccepted | null = null;

  private constructor(
    rules: PreparedSessionRules<
      WhiteState,
      WhiteParameters,
      BlackState,
      BlackParameters
    >,
    random: SessionParameterRandomInput,
    options: AsyncGameSessionOptions,
  ) {
    this.#chess =
      options.fen === undefined ? new Chess() : new Chess(options.fen);
    this.#provider = options.provider;
    const parameterRandom =
      resolveSessionParameterRandomSources(random);
    const whiteParameters =
      rules.white.generateParameters(parameterRandom.white);
    const blackParameters =
      rules.black.generateParameters(parameterRandom.black);
    const position = this.position();
    this.#white = {
      rule: rules.white,
      parameters: whiteParameters,
      state: rules.white.initialize({
        color: "white",
        parameters: whiteParameters,
        position,
      }),
    };
    this.#black = {
      rule: rules.black,
      parameters: blackParameters,
      state: rules.black.initialize({
        color: "black",
        parameters: blackParameters,
        position,
      }),
    };
  }

  public static async create<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters,
  >(
    rules: PreparedSessionRules<
      WhiteState,
      WhiteParameters,
      BlackState,
      BlackParameters
    >,
    random: SessionParameterRandomInput,
    options: AsyncGameSessionOptions = {},
  ): Promise<
    AsyncGameSession<
      WhiteState,
      WhiteParameters,
      BlackState,
      BlackParameters
    >
  > {
    const session = new AsyncGameSession(rules, random, options);
    await session.#ensurePrepared(false);
    return session;
  }

  public get result(): SessionResult {
    return this.#result;
  }

  public get fen(): string {
    return this.#chess.fen();
  }

  public get turn(): PlayerColor {
    return playerColor(this.#chess.turn());
  }

  public history(): readonly ChessMove[] {
    return [...this.#history];
  }

  public ordinaryLegalMoves(): readonly ChessMove[] {
    return [...this.#requirePrepared().ordinaryLegalMoves];
  }

  public legalMoves(): readonly ChessMove[] {
    return [...this.#requirePrepared().drawbackLegalMoves];
  }

  public exportSecretSnapshot(): {
    readonly white: RuleSecretSnapshot<WhiteParameters, WhiteState>;
    readonly black: RuleSecretSnapshot<BlackParameters, BlackState>;
  } {
    return structuredClone({
      white: {
        drawbackId: this.#white.rule.id,
        parameters: this.#white.parameters,
        state: this.#white.state,
      },
      black: {
        drawbackId: this.#black.rule.id,
        parameters: this.#black.parameters,
        state: this.#black.state,
      },
    });
  }

  public async retryPreparation(): Promise<MoveAccepted | null> {
    if (this.#prepared !== null || this.#result.kind !== "active") {
      return null;
    }
    await this.#ensurePrepared(false);
    if (this.#pendingAccepted === null) {
      return null;
    }
    const recovered = {
      ...this.#pendingAccepted,
      result: this.#result,
    };
    this.#pendingAccepted = null;
    return recovered;
  }

  public async move(command: MoveCommand): Promise<MoveOutcome> {
    if (this.#result.kind !== "active") {
      return {
        ok: false,
        reason: "game-over",
        message: "The game has already ended.",
      };
    }
    const prepared = this.#requirePrepared();
    const requested = prepared.ordinaryLegalMoves.find((move) =>
      sameMove(command, move)
    );
    if (requested === undefined) {
      return {
        ok: false,
        reason: "not-standard-legal",
        message: `${command.from}-${command.to} is not legal in standard chess.`,
      };
    }
    if (!prepared.drawbackLegalMoves.some((move) => sameMove(requested, move))) {
      return {
        ok: false,
        reason: "drawback-forbidden",
        message: `${requested.san} is forbidden by the active drawback.`,
      };
    }

    const fenBefore = this.fen;
    const movingColor = this.turn;
    const positionBefore = this.position();
    const applied = this.#chess.move({
      from: requested.from,
      to: requested.to,
      ...(requested.promotion === undefined
        ? {}
        : { promotion: PROMOTION_SYMBOL[requested.promotion] }),
    });
    const normalized = toChessMove(applied);
    this.#history.push(normalized);
    this.#transitionRule(movingColor, normalized, positionBefore);
    this.#revision += 1;
    this.#prepared = null;
    const accepted: MoveAccepted = {
      ok: true,
      observation: {
        fenBefore,
        fenAfter: this.fen,
        move: normalized,
        ordinaryLegalMoves: prepared.ordinaryLegalMoves,
        drawbackLegalMoves: prepared.drawbackLegalMoves,
        ruleTriggered:
          prepared.drawbackLegalMoves.length !==
          prepared.ordinaryLegalMoves.length,
        forced: prepared.drawbackLegalMoves.length === 1,
        ...(prepared.externalConstraint === undefined
          ? {}
          : { externalConstraint: prepared.externalConstraint }),
      },
      result: this.#result,
    };
    this.#pendingAccepted = accepted;
    try {
      await this.#ensurePrepared(true);
    } catch (error) {
      throw new AsyncSessionPreparationError(
        "The move was applied, but preparing the next turn failed.",
        true,
        { cause: error },
      );
    }

    const completed = { ...accepted, result: this.#result };
    this.#pendingAccepted = null;
    return completed;
  }

  private position(): PositionView {
    return {
      fen: this.#chess.fen(),
      turn: playerColor(this.#chess.turn()),
      ply: this.#history.length,
      history: [...this.#history],
    };
  }

  async #prepare(moveApplied: boolean): Promise<void> {
    if (this.#result.kind !== "active") {
      this.#prepared = Object.freeze({
        revision: this.#revision,
        ordinaryLegalMoves: Object.freeze([]),
        drawbackLegalMoves: Object.freeze([]),
      });
      return;
    }
    const loss = this.#ruleLoss();
    if (loss !== null) {
      this.#result = { kind: "drawback-loss", loss };
      this.#prepared = Object.freeze({
        revision: this.#revision,
        ordinaryLegalMoves: Object.freeze([]),
        drawbackLegalMoves: Object.freeze([]),
      });
      return;
    }
    const standardEnding = this.#standardEnding(opposite(this.turn));
    if (standardEnding !== null) {
      this.#result = standardEnding;
      this.#prepared = Object.freeze({
        revision: this.#revision,
        ordinaryLegalMoves: Object.freeze([]),
        drawbackLegalMoves: Object.freeze([]),
      });
      return;
    }

    const ordinary = Object.freeze(
      this.#chess.moves({ verbose: true }).map(toChessMove),
    );
    const revision = this.#revision;
    let filtered: readonly ChessMove[];
    let constraint: ExternalTurnConstraint | undefined;
    try {
      const resolved = await this.#filterFor(this.turn, ordinary);
      filtered = Object.freeze([...resolved.moves]);
      constraint = resolved.constraint;
    } catch (error) {
      this.#prepared = null;
      throw new AsyncSessionPreparationError(
        "Unable to prepare the active drawback turn.",
        moveApplied,
        { cause: error },
      );
    }
    if (revision !== this.#revision) {
      this.#prepared = null;
      throw new AsyncSessionPreparationError(
        "Discarded a stale prepared-turn result.",
        moveApplied,
      );
    }
    if (ordinary.length > 0 && filtered.length === 0) {
      this.#result = {
        kind: "drawback-loss",
        loss: {
          ruleId: this.#activeRule().id,
          color: this.turn,
          reason: "The drawback forbids every otherwise legal move.",
        },
      };
    }
    this.#prepared = Object.freeze({
      revision,
      ordinaryLegalMoves: ordinary,
      drawbackLegalMoves: filtered,
      ...(constraint === undefined ? {} : { externalConstraint: constraint }),
    });
  }

  #ensurePrepared(moveApplied: boolean): Promise<void> {
    if (this.#preparing !== null) {
      return this.#preparing;
    }
    const pending = this.#prepare(moveApplied).finally(() => {
      if (this.#preparing === pending) {
        this.#preparing = null;
      }
    });
    this.#preparing = pending;
    return pending;
  }

  async #filterFor(
    color: PlayerColor,
    moves: readonly ChessMove[],
  ): Promise<{
    readonly moves: readonly ChessMove[];
    readonly constraint?: ExternalTurnConstraint;
  }> {
    return color === "white"
      ? this.#filterRuntime(color, this.#white, moves)
      : this.#filterRuntime(color, this.#black, moves);
  }

  async #filterRuntime<State, Parameters>(
    color: PlayerColor,
    runtime: PreparedRuntime<State, Parameters>,
    moves: readonly ChessMove[],
  ): Promise<{
    readonly moves: readonly ChessMove[];
    readonly constraint?: ExternalTurnConstraint;
  }> {
    const context = {
      color,
      parameters: runtime.parameters,
      state: runtime.state,
      position: this.position(),
    };
    if (!isExternalRule(runtime.rule)) {
      if (this.#provider !== undefined) {
        const request = createEvaluatorTurnConstraintRequest(
          context.position,
          moves,
        );
        const constraint = await this.#provider.resolve(request);
        return {
          moves: runtime.rule.filterLegalMoves(context, [...moves]),
          constraint,
        };
      }
      return {
        moves: runtime.rule.filterLegalMoves(context, [...moves]),
      };
    }
    if (this.#provider === undefined) {
      throw new Error(
        `Rule ${runtime.rule.id} requires an external turn constraint provider.`,
      );
    }
    const request = runtime.rule.requestTurnConstraint(context, [...moves]);
    const constraint = await this.#provider.resolve(request);
    return {
      moves: runtime.rule.filterLegalMovesWithConstraint(
        context,
        [...moves],
        constraint,
      ),
      constraint,
    };
  }

  #activeRule(): PreparedSessionRule<unknown, unknown> {
    return this.turn === "white"
      ? this.#white.rule
      : this.#black.rule;
  }

  #ruleLoss(): DrawbackLoss | null {
    const color = this.turn;
    return color === "white"
      ? this.#runtimeLoss(color, this.#white)
      : this.#runtimeLoss(color, this.#black);
  }

  #runtimeLoss<State, Parameters>(
    color: PlayerColor,
    runtime: PreparedRuntime<State, Parameters>,
  ): DrawbackLoss | null {
    return runtime.rule.checkStartOfTurnLoss({
      color,
      parameters: runtime.parameters,
      state: runtime.state,
      position: this.position(),
    });
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
            positionAfterMove: this.position(),
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
          positionAfterMove: this.position(),
        },
        move,
      ),
    };
  }

  #standardEnding(previousMover: PlayerColor): SessionResult | null {
    if (this.#chess.isCheckmate()) {
      return { kind: "checkmate", winner: previousMover };
    }
    if (this.#chess.isStalemate()) {
      return { kind: "draw", reason: "stalemate" };
    }
    if (this.#chess.isThreefoldRepetition()) {
      return { kind: "draw", reason: "threefold repetition" };
    }
    if (this.#chess.isInsufficientMaterial()) {
      return { kind: "draw", reason: "insufficient material" };
    }
    if (this.#chess.isDrawByFiftyMoves()) {
      return { kind: "draw", reason: "fifty-move rule" };
    }
    return null;
  }

  #requirePrepared(): PreparedTurn {
    if (
      this.#prepared === null ||
      this.#prepared.revision !== this.#revision
    ) {
      throw new AsyncSessionPreparationError(
        "The active turn has not been prepared.",
        false,
      );
    }
    return this.#prepared;
  }
}
