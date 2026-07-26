import { Chess } from "chess.js";
import type {
  ChessMove,
  DrawbackLoss,
  ExternalTurnConstraint,
  DrawbackRule,
  PositionView,
  RuleRuntime,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor, RandomSource } from "@drawbackengine/shared";
import { opposite } from "@drawbackengine/shared";
import { playerColor, sameMove, toChessMove } from "./move-adapter.js";

export interface MoveCommand {
  readonly from: string;
  readonly to: string;
  readonly promotion?: "knight" | "bishop" | "rook" | "queen";
}

export interface SessionRules<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
> {
  readonly white: DrawbackRule<WhiteState, WhiteParameters>;
  readonly black: DrawbackRule<BlackState, BlackParameters>;
}

export type SessionResult =
  | { readonly kind: "active" }
  | { readonly kind: "drawback-loss"; readonly loss: DrawbackLoss }
  | {
      readonly kind: "king-capture";
      readonly winner: PlayerColor;
      readonly capturedKing: PlayerColor;
      readonly method: "direct" | "castling-en-passant";
    }
  | {
      readonly kind: "no-legal-moves";
      readonly winner: PlayerColor;
      readonly loser: PlayerColor;
    }
  | { readonly kind: "checkmate"; readonly winner: PlayerColor }
  | { readonly kind: "draw"; readonly reason: string };

export interface MoveObservation {
  readonly fenBefore: string;
  readonly fenAfter: string;
  readonly move: ChessMove;
  readonly ordinaryLegalMoves: readonly ChessMove[];
  readonly drawbackLegalMoves: readonly ChessMove[];
  readonly ruleTriggered: boolean;
  readonly forced: boolean;
  readonly externalConstraint?: ExternalTurnConstraint;
}

/**
 * Trusted engine-only data for simulation labels and post-game reveal.
 *
 * This must never be included in a move observation or passed to a player
 * agent. The defensive clone prevents callers from mutating live rule state.
 */
export interface RuleSecretSnapshot<Parameters, State> {
  readonly drawbackId: string;
  readonly parameters: Parameters;
  readonly state: State;
}

export interface SessionSecretSnapshot<
  WhiteParameters,
  WhiteState,
  BlackParameters,
  BlackState,
> {
  readonly white: RuleSecretSnapshot<WhiteParameters, WhiteState>;
  readonly black: RuleSecretSnapshot<BlackParameters, BlackState>;
}

export interface MoveAccepted {
  readonly ok: true;
  readonly observation: MoveObservation;
  readonly result: SessionResult;
}

export interface MoveRejected {
  readonly ok: false;
  readonly reason: "game-over" | "not-standard-legal" | "drawback-forbidden";
  readonly message: string;
}

export type MoveOutcome = MoveAccepted | MoveRejected;

const PROMOTION_SYMBOL = {
  knight: "n",
  bishop: "b",
  rook: "r",
  queen: "q",
} as const;

export class GameSession<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
> {
  readonly #chess: Chess;
  readonly #history: ChessMove[] = [];
  #white: RuleRuntime<WhiteState, WhiteParameters>;
  #black: RuleRuntime<BlackState, BlackParameters>;
  #result: SessionResult = { kind: "active" };

  public constructor(
    rules: SessionRules<WhiteState, WhiteParameters, BlackState, BlackParameters>,
    rng: RandomSource,
    fen?: string,
  ) {
    this.#chess = fen === undefined ? new Chess() : new Chess(fen);
    const whiteParameters = rules.white.generateParameters(rng);
    const blackParameters = rules.black.generateParameters(rng);
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
    const initialLoss = this.#startOfTurnLoss();
    if (initialLoss !== null) {
      this.#result = { kind: "drawback-loss", loss: initialLoss };
    } else {
      this.#evaluateStandardEnding(opposite(this.turn));
    }
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

  public exportSecretSnapshot(): SessionSecretSnapshot<
    WhiteParameters,
    WhiteState,
    BlackParameters,
    BlackState
  > {
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

  public ordinaryLegalMoves(): readonly ChessMove[] {
    return this.#chess.moves({ verbose: true }).map(toChessMove);
  }

  public legalMoves(): readonly ChessMove[] {
    const ordinary = this.ordinaryLegalMoves();
    return this.#filterFor(this.turn, ordinary);
  }

  public move(command: MoveCommand): MoveOutcome {
    if (this.#result.kind !== "active") {
      return { ok: false, reason: "game-over", message: "The game has already ended." };
    }

    const ordinaryLegalMoves = this.ordinaryLegalMoves();
    const requested = ordinaryLegalMoves.find((move) => sameMove(command, move));
    if (requested === undefined) {
      return {
        ok: false,
        reason: "not-standard-legal",
        message: `${command.from}-${command.to} is not legal in standard chess.`,
      };
    }

    const drawbackLegalMoves = this.#filterFor(this.turn, ordinaryLegalMoves);
    if (!drawbackLegalMoves.some((move) => sameMove(requested, move))) {
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
    const drawbackLoss = this.#startOfTurnLoss();
    if (drawbackLoss !== null) {
      this.#result = { kind: "drawback-loss", loss: drawbackLoss };
    } else {
      this.#evaluateStandardEnding(movingColor);
    }

    return {
      ok: true,
      observation: {
        fenBefore,
        fenAfter: this.fen,
        move: normalized,
        ordinaryLegalMoves,
        drawbackLegalMoves,
        ruleTriggered: drawbackLegalMoves.length !== ordinaryLegalMoves.length,
        forced: drawbackLegalMoves.length === 1,
      },
      result: this.#result,
    };
  }

  private position(): PositionView {
    return {
      fen: this.#chess.fen(),
      turn: playerColor(this.#chess.turn()),
      ply: this.#history.length,
      history: [...this.#history],
    };
  }

  #filterFor(color: PlayerColor, moves: readonly ChessMove[]): readonly ChessMove[] {
    if (color === "white") {
      return [
        ...this.#white.rule.filterLegalMoves(
          {
            color,
            parameters: this.#white.parameters,
            state: this.#white.state,
            position: this.position(),
          },
          [...moves],
        ),
      ];
    }
    return [
      ...this.#black.rule.filterLegalMoves(
        {
          color,
          parameters: this.#black.parameters,
          state: this.#black.state,
          position: this.position(),
        },
        [...moves],
      ),
    ];
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

  #startOfTurnLoss(): DrawbackLoss | null {
    const color = this.turn;
    const ruleLoss =
      color === "white"
        ? this.#white.rule.checkStartOfTurnLoss({
            color,
            parameters: this.#white.parameters,
            state: this.#white.state,
            position: this.position(),
          })
        : this.#black.rule.checkStartOfTurnLoss({
            color,
            parameters: this.#black.parameters,
            state: this.#black.state,
            position: this.position(),
          });
    if (ruleLoss !== null) {
      return ruleLoss;
    }

    const ordinaryMoves = this.ordinaryLegalMoves();
    if (ordinaryMoves.length > 0 && this.#filterFor(color, ordinaryMoves).length === 0) {
      const ruleId = color === "white" ? this.#white.rule.id : this.#black.rule.id;
      return {
        ruleId,
        color,
        reason: "The drawback forbids every otherwise legal move.",
      };
    }
    return null;
  }

  #evaluateStandardEnding(previousMover: PlayerColor): void {
    if (this.#chess.isCheckmate()) {
      this.#result = { kind: "checkmate", winner: previousMover };
    } else if (this.#chess.isStalemate()) {
      this.#result = { kind: "draw", reason: "stalemate" };
    } else if (this.#chess.isThreefoldRepetition()) {
      this.#result = { kind: "draw", reason: "threefold repetition" };
    } else if (this.#chess.isInsufficientMaterial()) {
      this.#result = { kind: "draw", reason: "insufficient material" };
    } else if (this.#chess.isDrawByFiftyMoves()) {
      this.#result = { kind: "draw", reason: "fifty-move rule" };
    }
  }
}
