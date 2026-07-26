import {
  DrawbackGameSession,
  publicGameTraceView,
  type DrawbackMoveObservation,
  type MoveCommand,
  type PublicGameTrace,
  type RuleSecretSnapshot,
  type SessionSecretSnapshot,
  type SessionResult,
  type SessionRules,
} from "@drawbackengine/chess-core";
import {
  unrestrictedRule,
  type ChessMove,
} from "@drawbackengine/drawback-engine";
import {
  createOwnPlayerRuleCapability,
  createPublicDrawbackHypothesis,
  PublicRuleStateReconstructionError,
  type OwnPlayerRuleCapability,
  type PublicDrawbackHypothesis,
} from "@drawbackengine/drawback-search";
import type {
  DrawbackRule,
  PositionView,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";
import type {
  HiddenDrawbackReveal,
} from "./simulation.js";
import {
  PLAYER_PRIVATE_RULE_IDS,
  resolvePlayerPrivateRule,
  type PlayerPrivateRuleId,
} from "./player-private-catalog.js";
import {
  type PlayerPrivateAgentSearchPolicy,
  type PlayerPrivateSimulationAgent,
} from "./player-private-agent.js";
import { createSimulationRandomStreams } from "./random-streams.js";
import type { SimulationParameterSeeds } from "./random-streams.js";

export interface PublicOpponentHypothesisRequest {
  readonly observerColor: PlayerColor;
  readonly opponentColor: PlayerColor;
  readonly trace: PublicGameTrace;
}

export interface PublicOpponentHypothesisProvider {
  readonly id: string;
  hypotheses(
    request: PublicOpponentHypothesisRequest,
  ):
    | readonly PublicDrawbackHypothesis[]
    | Promise<readonly PublicDrawbackHypothesis[]>;
}

export interface PlayerPrivateSimulationConfig<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
> {
  readonly seed: number;
  readonly parameterSeeds?: SimulationParameterSeeds;
  readonly rules: SessionRules<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters
  >;
  readonly whiteAgent: PlayerPrivateSimulationAgent;
  readonly blackAgent: PlayerPrivateSimulationAgent;
  readonly opponentHypotheses?: PublicOpponentHypothesisProvider;
  readonly maxPlies?: number;
  readonly fen?: string;
}

export interface PlayerPrivateSimulationPly {
  readonly ply: number;
  readonly color: PlayerColor;
  readonly observation: DrawbackMoveObservation;
  readonly drawback: RuleSecretSnapshot<unknown, unknown>;
}

export interface PlayerPrivateSimulationResult {
  readonly authorityId: "capturable-king/v1";
  readonly seed: number;
  readonly parameterSeeds: SimulationParameterSeeds;
  readonly plyLimit: number;
  readonly initialFen: string;
  readonly result: SessionResult;
  readonly plies: readonly PlayerPrivateSimulationPly[];
  readonly finalFen: string;
  readonly drawbacks: HiddenDrawbackReveal;
  readonly drawbackSecrets: {
    readonly initial: SessionSecretSnapshot<
      unknown,
      unknown,
      unknown,
      unknown
    >;
    readonly final: SessionSecretSnapshot<
      unknown,
      unknown,
      unknown,
      unknown
    >;
  };
  readonly hypothesisPolicyId: string;
  readonly agents: {
    readonly white: PlayerPrivateAgentSnapshot;
    readonly black: PlayerPrivateAgentSnapshot;
  };
  readonly stoppedAtPlyLimit: boolean;
}

export interface PlayerPrivateAgentSnapshot {
  readonly id: string;
  readonly style: string | null;
  readonly strength: number | null;
  readonly searchPolicy: PlayerPrivateAgentSearchPolicy | null;
}

const DEFAULT_MAX_PLIES = 300;
const MAX_UNSIGNED_32_BIT_INTEGER = 0xffff_ffff;

export async function simulatePlayerPrivateGame<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
>(
  config: PlayerPrivateSimulationConfig<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters
  >,
): Promise<PlayerPrivateSimulationResult> {
  const maxPlies = config.maxPlies ?? DEFAULT_MAX_PLIES;
  if (!Number.isSafeInteger(maxPlies) || maxPlies <= 0) {
    throw new RangeError("maxPlies must be a positive safe integer.");
  }
  const seed = checkedSeed(config.seed);
  const random = createSimulationRandomStreams(seed, config.parameterSeeds);
  const session = DrawbackGameSession.create(
    config.rules,
    random.parameters,
    config.fen,
  );
  const initialFen = session.fen;
  const initialSecrets = session.exportSecretSnapshot();
  const plies: PlayerPrivateSimulationPly[] = [];
  const hypothesisProvider =
    config.opponentHypotheses ?? unrestrictedOpponentHypotheses;
  if (
    hypothesisProvider.id.trim().length === 0
    || /[\r\n]/u.test(hypothesisProvider.id)
  ) {
    throw new RangeError(
      "Opponent hypothesis provider ID must be non-empty and single-line.",
    );
  }

  while (session.result.kind === "active" && plies.length < maxPlies) {
    const legalMoves = session.legalMoves();
    if (legalMoves.length === 0) {
      throw new Error(
        "Active capturable session has no drawback-legal moves.",
      );
    }
    const color = session.turn;
    const secrets = session.exportSecretSnapshot();
    const active =
      color === "white"
        ? activePlayerCapability(
            color,
            config.rules.white,
            secrets.white,
            publicGameTraceView(session.publicGameTrace()),
          )
        : activePlayerCapability(
            color,
            config.rules.black,
            secrets.black,
            publicGameTraceView(session.publicGameTrace()),
          );
    const agent =
      color === "white" ? config.whiteAgent : config.blackAgent;
    const trace = session.publicGameTrace();
    const opponent = await hypothesisProvider.hypotheses({
      observerColor: color,
      opponentColor: opposite(color),
      trace,
    });
    if (opponent.length === 0) {
      throw new Error(
        "Player-private simulation has no public opponent hypotheses.",
      );
    }
    const selected = await agent.chooseMove(
      Object.freeze({
        color,
        ply: plies.length,
        legalMoves: Object.freeze(structuredClone([...legalMoves])),
        trace,
        own: active.own,
        opponent: Object.freeze([...opponent]),
      }),
      random.agent(color, plies.length),
    );
    const outcome = session.move(toCommand(selected));
    if (!outcome.ok) {
      throw new Error(
        `Agent ${agent.id} returned an invalid move (${outcome.reason}): ${outcome.message}`,
      );
    }
    plies.push(Object.freeze({
      ply: plies.length,
      color,
      observation: outcome.observation,
      drawback: active.secret,
    }));
  }

  return Object.freeze({
    authorityId: "capturable-king/v1",
    seed,
    parameterSeeds: random.parameterSeeds,
    plyLimit: maxPlies,
    initialFen,
    result: session.result,
    plies: Object.freeze(plies),
    finalFen: session.fen,
    drawbacks: Object.freeze({
      white: config.rules.white.id,
      black: config.rules.black.id,
    }),
    drawbackSecrets: Object.freeze({
      initial: structuredClone(initialSecrets),
      final: session.exportSecretSnapshot(),
    }),
    hypothesisPolicyId: hypothesisProvider.id,
    agents: Object.freeze({
      white: agentSnapshot(config.whiteAgent),
      black: agentSnapshot(config.blackAgent),
    }),
    stoppedAtPlyLimit:
      session.result.kind === "active" && plies.length === maxPlies,
  });
}

export const unrestrictedOpponentHypotheses: PublicOpponentHypothesisProvider =
  Object.freeze({
    id: "unrestricted-baseline/v1",
    hypotheses(request: PublicOpponentHypothesisRequest) {
      return Object.freeze([
        createPublicDrawbackHypothesis(
          `public-${request.opponentColor}-unrestricted`,
          1,
          request.opponentColor,
          unrestrictedRule,
          {},
          request.trace,
        ),
      ]);
    },
  });

const AUDITED_RULE_MASS = 1 / PLAYER_PRIVATE_RULE_IDS.length;

/**
 * Equal prior mass per audited drawback label, reconstructed exclusively from
 * the authenticated public replay. Triple Play's two observed parameter
 * particles split that label's mass rather than receiving double weight.
 */
export const auditedUniformOpponentHypotheses:
  PublicOpponentHypothesisProvider = Object.freeze({
    id: "audited-uniform/v1",
    hypotheses(request: PublicOpponentHypothesisRequest) {
      const surviving: PublicDrawbackHypothesis[] = [];
      for (const ruleId of PLAYER_PRIVATE_RULE_IDS) {
        const parameterParticles = publicParameterParticles(ruleId);
        for (const parameters of parameterParticles) {
          try {
            surviving.push(
              createPublicDrawbackHypothesis(
                publicHypothesisId(
                  request.opponentColor,
                  ruleId,
                  parameters,
                ),
                AUDITED_RULE_MASS / parameterParticles.length,
                request.opponentColor,
                resolvePlayerPrivateRule(ruleId),
                parameters,
                request.trace,
              ),
            );
          } catch (error: unknown) {
            if (
              error instanceof PublicRuleStateReconstructionError
              && (
                error.code === "hypothesis-already-lost"
                || error.code === "observed-move-illegal"
              )
            ) {
              continue;
            }
            throw error;
          }
        }
      }
      return normalizePublicHypotheses(surviving);
    },
  });

function normalizePublicHypotheses(
  hypotheses: readonly PublicDrawbackHypothesis[],
): readonly PublicDrawbackHypothesis[] {
  const total = hypotheses.reduce(
    (sum, hypothesis) => sum + hypothesis.probability,
    0,
  );
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(
      "Authenticated public play eliminated every audited opponent hypothesis.",
    );
  }
  return Object.freeze(
    hypotheses.map((hypothesis) =>
      Object.freeze({
        ...hypothesis,
        probability: hypothesis.probability / total,
      })
    ),
  );
}

function publicParameterParticles(
  ruleId: PlayerPrivateRuleId,
): readonly Record<string, unknown>[] {
  return ruleId === "triple-play"
    ? Object.freeze([
        Object.freeze({ requiredType: "bishop" }),
        Object.freeze({ requiredType: "knight" }),
      ])
    : Object.freeze([Object.freeze({})]);
}

function publicHypothesisId(
  color: PlayerColor,
  ruleId: PlayerPrivateRuleId,
  parameters: Readonly<Record<string, unknown>>,
): string {
  const requiredType = parameters["requiredType"];
  if (requiredType === undefined) {
    return `public-${color}-${ruleId}`;
  }
  if (requiredType !== "bishop" && requiredType !== "knight") {
    throw new TypeError(
      "Public Triple Play parameter particle is unsupported.",
    );
  }
  return `public-${color}-${ruleId}-${requiredType}`;
}

function agentSnapshot(
  agent: PlayerPrivateSimulationAgent,
): PlayerPrivateAgentSnapshot {
  return Object.freeze({
    id: agent.id,
    style: agent.style ?? null,
    strength: agent.strength ?? null,
    searchPolicy:
      agent.searchPolicy === undefined
        ? null
        : Object.freeze(structuredClone(agent.searchPolicy)),
  });
}

function toCommand(move: ChessMove): MoveCommand {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
}

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function activePlayerCapability<State, Parameters>(
  color: PlayerColor,
  rule: DrawbackRule<State, Parameters>,
  secret: RuleSecretSnapshot<Parameters, State>,
  position: PositionView,
): {
  readonly secret: RuleSecretSnapshot<unknown, unknown>;
  readonly own: OwnPlayerRuleCapability;
} {
  return Object.freeze({
    secret: structuredClone(secret),
    own: createOwnPlayerRuleCapability(
      "capturable-king/v1",
      color,
      rule,
      secret.parameters,
      secret.state,
      position,
    ),
  });
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
