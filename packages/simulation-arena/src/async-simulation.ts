import {
  AsyncGameSession,
  AsyncSessionPreparationError,
  type MoveCommand,
  type MoveOutcome,
  type PreparedSessionRules,
} from "@drawbackengine/chess-core";
import type {
  ExternalTurnConstraintProvider,
} from "@drawbackengine/drawback-engine";
import { Mulberry32, type RandomSource } from "@drawbackengine/shared";
import type {
  AgentView,
  SimulationAgent,
  SimulationConfig,
  SimulationPly,
  SimulationResult,
} from "./simulation.js";

export interface AsyncSimulationAgent {
  readonly id: string;
  readonly style?: string;
  readonly strength?: number;
  chooseMove(view: AgentView, rng: RandomSource): Promise<
    AgentView["legalMoves"][number]
  >;
}

export interface AsyncSimulationConfig<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
> extends Omit<
    SimulationConfig<
      WhiteState,
      WhiteParameters,
      BlackState,
      BlackParameters
    >,
    "whiteAgent" | "blackAgent" | "rules"
  > {
  readonly rules: PreparedSessionRules<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters
  >;
  readonly whiteAgent: AsyncSimulationAgent;
  readonly blackAgent: AsyncSimulationAgent;
  /**
   * Borrowed provider used to prepare evaluator-backed drawback turns.
   * Lifecycle ownership remains with the caller.
   */
  readonly turnConstraintProvider?: ExternalTurnConstraintProvider;
}

const DEFAULT_MAX_PLIES = 300;

function toCommand(
  move: AgentView["legalMoves"][number],
): MoveCommand {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
}

export function asAsyncAgent(agent: SimulationAgent): AsyncSimulationAgent {
  return {
    id: agent.id,
    ...(agent.style === undefined ? {} : { style: agent.style }),
    ...(agent.strength === undefined ? {} : { strength: agent.strength }),
    chooseMove(view, rng) {
      return Promise.resolve(agent.chooseMove(view, rng));
    },
  };
}

export async function simulateGameAsync<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
>(
  config: AsyncSimulationConfig<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters
  >,
): Promise<SimulationResult> {
  const maxPlies = config.maxPlies ?? DEFAULT_MAX_PLIES;
  if (!Number.isSafeInteger(maxPlies) || maxPlies <= 0) {
    throw new RangeError("maxPlies must be a positive safe integer.");
  }

  const rng = new Mulberry32(config.seed);
  const session = await AsyncGameSession.create(config.rules, rng, {
    ...(config.fen === undefined ? {} : { fen: config.fen }),
    ...(config.turnConstraintProvider === undefined
      ? {}
      : { provider: config.turnConstraintProvider }),
  });
  const plies: SimulationPly[] = [];

  while (session.result.kind === "active" && plies.length < maxPlies) {
    const legalMoves = session.legalMoves();
    if (legalMoves.length === 0) {
      throw new Error(
        "Active session has no drawback-legal moves; the rule must report this as a loss.",
      );
    }
    const color = session.turn;
    const secrets = session.exportSecretSnapshot();
    const activeSecret = color === "white" ? secrets.white : secrets.black;
    const agent = color === "white" ? config.whiteAgent : config.blackAgent;
    const selected = await agent.chooseMove(
      {
        color,
        fen: session.fen,
        ply: plies.length,
        legalMoves: [...legalMoves],
        history: session.history(),
      },
      rng,
    );
    let outcome: MoveOutcome;
    try {
      outcome = await session.move(toCommand(selected));
    } catch (error) {
      if (
        !(error instanceof AsyncSessionPreparationError) ||
        !error.moveApplied
      ) {
        throw error;
      }
      try {
        const recovered = await session.retryPreparation();
        if (recovered === null) {
          throw new Error(
            "The session did not return its pending accepted move.",
          );
        }
        outcome = recovered;
      } catch (retryError) {
        throw new AsyncSessionPreparationError(
          "The move was applied, but simulation could not recover next-turn preparation.",
          true,
          { cause: retryError },
        );
      }
    }
    if (!outcome.ok) {
      throw new Error(
        `Agent ${agent.id} returned an invalid move (${outcome.reason}): ${outcome.message}`,
      );
    }
    plies.push({
      ply: plies.length,
      color,
      observation: outcome.observation,
      drawback: activeSecret,
    });
  }

  return {
    seed: config.seed,
    result: session.result,
    plies,
    finalFen: session.fen,
    drawbacks: {
      white: config.rules.white.id,
      black: config.rules.black.id,
    },
    agents: {
      white: {
        id: config.whiteAgent.id,
        style: config.whiteAgent.style ?? null,
        strength: config.whiteAgent.strength ?? null,
      },
      black: {
        id: config.blackAgent.id,
        style: config.blackAgent.style ?? null,
        strength: config.blackAgent.strength ?? null,
      },
    },
    stoppedAtPlyLimit:
      session.result.kind === "active" && plies.length === maxPlies,
  };
}
