import { randomBytes } from "node:crypto";
import {
  DrawbackGameSession,
  publicGameTraceView,
  type MoveCommand,
  type SessionResult,
  type SessionRules,
} from "@drawbackengine/chess-core";
import {
  parseFenPieces,
  type ChessMove,
  type PieceType,
  type PositionView,
  type RuleVerification,
  type UnknownRule,
} from "@drawbackengine/drawback-engine";
import {
  createOwnPlayerRuleCapability,
  searchIterativePlayerPrivateDrawbackMove,
  type DrawbackLeafEvaluator,
  type IterativePlayerPrivateSearchLimits,
  type IterativePlayerPrivateSearchResult,
  type PlayerPrivateSearchContext,
} from "@drawbackengine/drawback-search";
import {
  deriveSimulationStreamSeed,
  Mulberry32,
  opposite,
  type PlayerColor,
} from "@drawbackengine/shared";
import {
  PLAYER_PRIVATE_RULE_IDS,
  resolvePlayerPrivateRule,
  type PlayerPrivateRuleId,
} from "./player-private-catalog.js";
import {
  auditedUniformOpponentHypotheses,
} from "./player-private-simulation.js";
import { createSimulationRandomStreams } from "./random-streams.js";

const HUMAN_RULE_DOMAIN = 0xb15a_4e17;
const ENGINE_RULE_DOMAIN = 0x4c29_d8a3;
const MAX_UNSIGNED_32_BIT_INTEGER = 0xffff_ffff;
const ACTION_TOKEN_BYTES = 18;

export interface PlayerObservedPiece {
  readonly color: PlayerColor;
  readonly type: PieceType;
}

export interface PlayerObservedSquare {
  readonly square: string;
  readonly visibility: "known";
  readonly occupant: PlayerObservedPiece | null;
}

export interface PlayerPlayAction {
  /** Random position-scoped capability; it contains no move coordinates. */
  readonly actionId: string;
  readonly from: string;
  readonly to: string;
  readonly promotion?: "knight" | "bishop" | "rook" | "queen";
}

export interface PlayerVisibleMove {
  readonly from: string;
  readonly to: string;
  readonly promotion?: "knight" | "bishop" | "rook" | "queen";
}

export interface OwnDrawbackDisclosure {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly verification: RuleVerification;
  readonly turnInstructions: readonly string[];
}

export type PlayerPlayStatus =
  | { readonly kind: "active" }
  | {
      readonly kind: "win";
      readonly winner: PlayerColor;
      readonly reason:
        | "drawback-loss"
        | "king-capture"
        | "no-legal-moves"
        | "checkmate"
        | "resignation";
    }
  | { readonly kind: "draw"; readonly reason: string };

/**
 * Full-board projection for the currently supported, full-information
 * player-private catalog. It deliberately contains no FEN, SAN, captured
 * piece metadata, seed, rule state, or opponent secret.
 */
export interface PlayerPlayObservationV1 {
  readonly schema: "drawbackengine-player-play-observation/v1";
  readonly viewer: PlayerColor;
  readonly turn: PlayerColor;
  readonly ply: number;
  readonly board: readonly PlayerObservedSquare[];
  readonly actions: readonly PlayerPlayAction[];
  readonly lastMove: PlayerVisibleMove | null;
  readonly ownDrawback: OwnDrawbackDisclosure;
  readonly status: PlayerPlayStatus;
}

export interface DrawbackPlayReveal {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly verification: RuleVerification;
  readonly details: readonly string[];
}

export interface PlayerPrivatePlayReveal {
  readonly white: DrawbackPlayReveal;
  readonly black: DrawbackPlayReveal;
}

export interface PlayerPrivatePlayOptions {
  readonly seed: number;
  readonly humanColor: PlayerColor;
  readonly humanDrawbackId?: PlayerPrivateRuleId;
  readonly engineDrawbackId?: PlayerPrivateRuleId;
  readonly initialFen?: string;
}

export interface PlayerPrivatePlaySearchRequest {
  readonly context: PlayerPrivateSearchContext;
  readonly evaluator: DrawbackLeafEvaluator;
  readonly limits: IterativePlayerPrivateSearchLimits;
}

export type PlayerPrivatePlaySearch = (
  request: PlayerPrivatePlaySearchRequest,
) => Promise<IterativePlayerPrivateSearchResult>;

export interface PlayerPrivatePlayDependencies {
  readonly search?: PlayerPrivatePlaySearch;
}

export type PlayerActionSubmission =
  | {
      readonly ok: true;
      readonly move: PlayerVisibleMove;
      readonly observation: PlayerPlayObservationV1;
    }
  | {
      readonly ok: false;
      readonly message: "Action is no longer available.";
      readonly observation: PlayerPlayObservationV1;
    };

export interface PlayerPrivateEngineMove {
  readonly move: PlayerVisibleMove;
  readonly evaluatorId: string;
  readonly knowledgeMode: "player-private";
  readonly observation: PlayerPlayObservationV1;
}

export class PlayerPrivatePlayStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PlayerPrivatePlayStateError";
  }
}

type ExactSession = DrawbackGameSession<unknown, unknown, unknown, unknown>;

interface ActiveActions {
  readonly ply: number;
  readonly actions: readonly PlayerPlayAction[];
  readonly commands: ReadonlyMap<string, MoveCommand>;
}

interface PlayMutationGuard {
  epoch: number;
  engineTurnInFlight: boolean;
}

/**
 * Trusted local coordinator for exactly one human and one private-search
 * engine. The authoritative session never crosses the player or search
 * boundary.
 */
export class PlayerPrivatePlayGame {
  readonly #session: ExactSession;
  readonly #rules: SessionRules<unknown, unknown, unknown, unknown>;
  readonly #humanColor: PlayerColor;
  readonly #search: PlayerPrivatePlaySearch;
  readonly #mutationGuard: PlayMutationGuard = {
    epoch: 0,
    engineTurnInFlight: false,
  };
  #activeActions: ActiveActions | null = null;
  #lastMove: PlayerVisibleMove | null = null;
  #resigned = false;

  private constructor(
    session: ExactSession,
    rules: SessionRules<unknown, unknown, unknown, unknown>,
    humanColor: PlayerColor,
    search: PlayerPrivatePlaySearch,
  ) {
    this.#session = session;
    this.#rules = rules;
    this.#humanColor = humanColor;
    this.#search = search;
  }

  public static create(
    options: PlayerPrivatePlayOptions,
    dependencies: PlayerPrivatePlayDependencies = {},
  ): PlayerPrivatePlayGame {
    const seed = checkedSeed(options.seed);
    const humanRuleId = options.humanDrawbackId
      ?? randomRuleId(seed, HUMAN_RULE_DOMAIN);
    const engineRuleId = options.engineDrawbackId
      ?? randomRuleId(seed, ENGINE_RULE_DOMAIN);
    const humanRule = resolvePlayerPrivateRule(humanRuleId);
    const engineRule = resolvePlayerPrivateRule(engineRuleId);
    const rules = rulesForColors(options.humanColor, humanRule, engineRule);
    const random = createSimulationRandomStreams(seed);
    const session = DrawbackGameSession.create(
      rules,
      random.parameters,
      options.initialFen,
    );
    return new PlayerPrivatePlayGame(
      session,
      rules,
      options.humanColor,
      dependencies.search ?? defaultPlayerPrivatePlaySearch,
    );
  }

  public get humanColor(): PlayerColor {
    return this.#humanColor;
  }

  public get engineColor(): PlayerColor {
    return opposite(this.#humanColor);
  }

  public observation(): PlayerPlayObservationV1 {
    const position = publicGameTraceView(this.#session.publicGameTrace());
    const ownRule = this.#ruleFor(this.#humanColor);
    const ownSecret = this.#secretFor(this.#humanColor);
    const actions = this.#actionsForCurrentPosition();
    return freezeObservation({
      schema: "drawbackengine-player-play-observation/v1",
      viewer: this.#humanColor,
      turn: this.#session.turn,
      ply: position.ply,
      board: projectBoard(this.#session.publicPositionSnapshot().fen),
      actions,
      lastMove:
        this.#lastMove === null
          ? null
          : freezeVisibleMove(this.#lastMove),
      ownDrawback: Object.freeze({
        id: ownRule.id,
        name: ownRule.name,
        description: ownRule.description,
        verification: ownRule.verification,
        turnInstructions: projectTurnInstructions(
          ownRule,
          this.#humanColor,
          ownSecret.parameters,
          ownSecret.state,
          position,
        ),
      }),
      status: this.#status(),
    });
  }

  public submitHumanAction(actionId: string): PlayerActionSubmission {
    if (
      this.#resigned
      || this.#session.result.kind !== "active"
      || this.#session.turn !== this.#humanColor
    ) {
      return unavailableSubmission(this.observation());
    }
    const current = this.#actionsForCurrentPosition();
    const command = this.#activeActions?.commands.get(actionId);
    if (
      command === undefined
      || !current.some((action) => action.actionId === actionId)
    ) {
      return unavailableSubmission(this.observation());
    }
    const outcome = this.#session.move(command);
    if (!outcome.ok) {
      throw new PlayerPrivatePlayStateError(
        "A projected human action was rejected by the authoritative session.",
      );
    }
    this.#lastMove = visibleMove(outcome.observation.move);
    this.#markStateChanged();
    return Object.freeze({
      ok: true,
      move: freezeVisibleMove(this.#lastMove),
      observation: this.observation(),
    });
  }

  public async playEngineTurn(
    evaluator: DrawbackLeafEvaluator,
    limits: IterativePlayerPrivateSearchLimits,
  ): Promise<PlayerPrivateEngineMove> {
    if (this.#mutationGuard.engineTurnInFlight) {
      throw new PlayerPrivatePlayStateError(
        "An engine turn is already in progress.",
      );
    }
    if (this.#resigned || this.#session.result.kind !== "active") {
      throw new PlayerPrivatePlayStateError("The game is not active.");
    }
    if (this.#session.turn !== this.engineColor) {
      throw new PlayerPrivatePlayStateError("It is not the engine's turn.");
    }
    throwIfAborted(limits.signal);
    const expectedEpoch = this.#mutationGuard.epoch;
    const trace = this.#session.publicGameTrace();
    const expectedTurn = this.#session.turn;
    const expectedPly = trace.ply;
    this.#mutationGuard.engineTurnInFlight = true;
    try {
      const position = publicGameTraceView(trace);
      const engineRule = this.#ruleFor(this.engineColor);
      const engineSecret = this.#secretFor(this.engineColor);
      const own = createOwnPlayerRuleCapability(
        "capturable-king/v1",
        this.engineColor,
        engineRule,
        engineSecret.parameters as Readonly<unknown>,
        engineSecret.state as Readonly<unknown>,
        position,
      );
      const opponent = await auditedUniformOpponentHypotheses.hypotheses({
        observerColor: this.engineColor,
        opponentColor: this.#humanColor,
        trace,
      });
      throwIfAborted(limits.signal);
      const result = await this.#search(Object.freeze({
        context: Object.freeze({
          trace,
          own,
          opponent: Object.freeze([...opponent]),
          aggregation: "worst-case" as const,
        }),
        evaluator,
        limits: Object.freeze({ ...limits }),
      }));
      throwIfAborted(limits.signal);
      this.#assertEngineCommitIsCurrent(
        expectedEpoch,
        trace,
        expectedTurn,
        expectedPly,
      );
      if (
        result.rootColor !== this.engineColor
        || result.evaluatorId !== evaluator.id
      ) {
        throw new PlayerPrivatePlayStateError(
          "Player-private search returned incompatible provenance.",
        );
      }
      const outcome = this.#session.move(moveCommand(result.move));
      if (!outcome.ok) {
        throw new PlayerPrivatePlayStateError(
          "Player-private search selected a move rejected by the authoritative session.",
        );
      }
      this.#lastMove = visibleMove(outcome.observation.move);
      this.#markStateChanged();
      return Object.freeze({
        move: freezeVisibleMove(this.#lastMove),
        evaluatorId: evaluator.id,
        knowledgeMode: "player-private",
        observation: this.observation(),
      });
    } catch (error: unknown) {
      throwIfAborted(limits.signal);
      throw error;
    } finally {
      this.#mutationGuard.engineTurnInFlight = false;
    }
  }

  public resignHuman(): PlayerPlayObservationV1 {
    if (this.#resigned || this.#session.result.kind !== "active") {
      throw new PlayerPrivatePlayStateError("The game is not active.");
    }
    this.#resigned = true;
    this.#markStateChanged();
    return this.observation();
  }

  public reveal(): PlayerPrivatePlayReveal {
    if (!this.#resigned && this.#session.result.kind === "active") {
      throw new PlayerPrivatePlayStateError(
        "Drawbacks cannot be revealed before the game ends.",
      );
    }
    const secrets = this.#session.exportSecretSnapshot();
    return Object.freeze({
      white: revealRule(this.#rules.white, secrets.white.parameters),
      black: revealRule(this.#rules.black, secrets.black.parameters),
    });
  }

  #actionsForCurrentPosition(): readonly PlayerPlayAction[] {
    if (
      this.#resigned
      || this.#session.result.kind !== "active"
      || this.#session.turn !== this.#humanColor
    ) {
      return Object.freeze([]);
    }
    const ply = this.#session.history().length;
    if (this.#activeActions?.ply === ply) {
      return this.#activeActions.actions;
    }
    const commands = new Map<string, MoveCommand>();
    const actions = this.#session.legalMoves().map((move) => {
      let actionId: string;
      do {
        actionId = randomActionId();
      } while (commands.has(actionId));
      commands.set(actionId, moveCommand(move));
      return Object.freeze({
        actionId,
        from: move.from,
        to: move.to,
        ...(move.promotion === undefined
          ? {}
          : { promotion: move.promotion }),
      });
    });
    this.#activeActions = Object.freeze({
      ply,
      actions: Object.freeze(actions),
      commands,
    });
    return this.#activeActions.actions;
  }

  #expireActions(): void {
    this.#activeActions = null;
  }

  #markStateChanged(): void {
    this.#mutationGuard.epoch += 1;
    this.#expireActions();
  }

  #assertEngineCommitIsCurrent(
    expectedEpoch: number,
    expectedTrace: ReturnType<ExactSession["publicGameTrace"]>,
    expectedTurn: PlayerColor,
    expectedPly: number,
  ): void {
    if (
      this.#mutationGuard.epoch !== expectedEpoch
      || this.#resigned
      || this.#session.result.kind !== "active"
      || this.#session.turn !== expectedTurn
      || this.#session.turn !== this.engineColor
      || this.#session.publicGameTrace() !== expectedTrace
      || this.#session.publicGameTrace().ply !== expectedPly
    ) {
      throw new PlayerPrivatePlayStateError(
        "The game changed while the engine was thinking.",
      );
    }
  }

  #ruleFor(color: PlayerColor): UnknownRule {
    return color === "white" ? this.#rules.white : this.#rules.black;
  }

  #secretFor(color: PlayerColor): {
    readonly parameters: unknown;
    readonly state: unknown;
  } {
    const secrets = this.#session.exportSecretSnapshot();
    const own = color === "white" ? secrets.white : secrets.black;
    return Object.freeze({
      parameters: structuredClone(own.parameters),
      state: structuredClone(own.state),
    });
  }

  #status(): PlayerPlayStatus {
    if (this.#resigned) {
      return Object.freeze({
        kind: "win",
        winner: this.engineColor,
        reason: "resignation",
      });
    }
    return projectSessionResult(this.#session.result);
  }
}

async function defaultPlayerPrivatePlaySearch(
  request: PlayerPrivatePlaySearchRequest,
): Promise<IterativePlayerPrivateSearchResult> {
  return searchIterativePlayerPrivateDrawbackMove(
    request.context,
    request.evaluator,
    request.limits,
  );
}

function rulesForColors(
  humanColor: PlayerColor,
  humanRule: UnknownRule,
  engineRule: UnknownRule,
): SessionRules<unknown, unknown, unknown, unknown> {
  return humanColor === "white"
    ? Object.freeze({ white: humanRule, black: engineRule })
    : Object.freeze({ white: engineRule, black: humanRule });
}

function randomRuleId(seed: number, domain: number): PlayerPrivateRuleId {
  const rng = new Mulberry32(deriveSimulationStreamSeed(seed, domain, 0));
  const selected = PLAYER_PRIVATE_RULE_IDS[
    rng.integer(PLAYER_PRIVATE_RULE_IDS.length)
  ];
  if (selected === undefined) {
    throw new RangeError("The player-private catalog is empty.");
  }
  return selected;
}

function checkedSeed(seed: number): number {
  if (
    !Number.isSafeInteger(seed)
    || seed < 0
    || seed > MAX_UNSIGNED_32_BIT_INTEGER
  ) {
    throw new RangeError("seed must be an unsigned 32-bit integer.");
  }
  return seed;
}

function randomActionId(): string {
  return `action_${randomBytes(ACTION_TOKEN_BYTES).toString("base64url")}`;
}

function projectBoard(fen: string): readonly PlayerObservedSquare[] {
  const pieces = new Map(
    parseFenPieces(fen).map((piece) => [piece.square, piece] as const),
  );
  const squares: PlayerObservedSquare[] = [];
  for (let rank = 1; rank <= 8; rank += 1) {
    for (const file of "abcdefgh") {
      const square = `${file}${String(rank)}`;
      const piece = pieces.get(square);
      squares.push(Object.freeze({
        square,
        visibility: "known",
        occupant:
          piece === undefined
            ? null
            : Object.freeze({ color: piece.color, type: piece.type }),
      }));
    }
  }
  return Object.freeze(squares);
}

function projectTurnInstructions(
  rule: UnknownRule,
  color: PlayerColor,
  parameters: unknown,
  state: unknown,
  position: PositionView,
): readonly string[] {
  const instructions = rule.describeTurn?.({
    color,
    parameters: parameters as Readonly<unknown>,
    state: state as Readonly<unknown>,
    position,
  }) ?? [];
  const safe = instructions.map((instruction) => {
    if (
      typeof instruction !== "string"
      || instruction.length === 0
      || /[\r\n\0]/u.test(instruction)
    ) {
      throw new PlayerPrivatePlayStateError(
        `${rule.id} returned an invalid player instruction.`,
      );
    }
    return instruction;
  });
  const triplePlay = triplePlayInstruction(rule.id, parameters);
  if (triplePlay !== null && !safe.includes(triplePlay)) {
    safe.push(triplePlay);
  }
  return Object.freeze(safe);
}

function triplePlayInstruction(
  ruleId: string,
  parameters: unknown,
): string | null {
  if (ruleId !== "triple-play") {
    return null;
  }
  if (
    typeof parameters !== "object"
    || parameters === null
    || Array.isArray(parameters)
  ) {
    throw new PlayerPrivatePlayStateError(
      "Triple Play parameters are unavailable for player disclosure.",
    );
  }
  const requiredType = (parameters as Record<string, unknown>)["requiredType"];
  if (requiredType !== "bishop" && requiredType !== "knight") {
    throw new PlayerPrivatePlayStateError(
      "Triple Play has an invalid required piece type.",
    );
  }
  return `Required piece type: ${requiredType}.`;
}

function revealRule(
  rule: UnknownRule,
  parameters: unknown,
): DrawbackPlayReveal {
  const parameterDetail = triplePlayInstruction(rule.id, parameters);
  return Object.freeze({
    id: rule.id,
    name: rule.name,
    description: rule.description,
    verification: rule.verification,
    details: Object.freeze(
      parameterDetail === null ? [] : [parameterDetail],
    ),
  });
}

function projectSessionResult(result: SessionResult): PlayerPlayStatus {
  switch (result.kind) {
    case "active":
      return Object.freeze({ kind: "active" });
    case "drawback-loss":
      return Object.freeze({
        kind: "win",
        winner: opposite(result.loss.color),
        reason: "drawback-loss",
      });
    case "king-capture":
      return Object.freeze({
        kind: "win",
        winner: result.winner,
        reason: "king-capture",
      });
    case "no-legal-moves":
      return Object.freeze({
        kind: "win",
        winner: result.winner,
        reason: "no-legal-moves",
      });
    case "checkmate":
      return Object.freeze({
        kind: "win",
        winner: result.winner,
        reason: "checkmate",
      });
    case "draw":
      return Object.freeze({ kind: "draw", reason: result.reason });
  }
}

function moveCommand(move: Pick<ChessMove, "from" | "to" | "promotion">): MoveCommand {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
}

function visibleMove(
  move: Pick<ChessMove, "from" | "to" | "promotion">,
): PlayerVisibleMove {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
}

function freezeVisibleMove(move: PlayerVisibleMove): PlayerVisibleMove {
  return Object.freeze({ ...move });
}

function unavailableSubmission(
  observation: PlayerPlayObservationV1,
): PlayerActionSubmission {
  return Object.freeze({
    ok: false,
    message: "Action is no longer available.",
    observation,
  });
}

function freezeObservation(
  observation: PlayerPlayObservationV1,
): PlayerPlayObservationV1 {
  return Object.freeze(observation);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  const reason: unknown = signal.reason;
  throw reason instanceof Error
    ? reason
    : new DOMException("The player-private search was aborted.", "AbortError");
}
