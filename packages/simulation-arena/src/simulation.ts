import {
  GameSession,
  type MoveCommand,
  type MoveObservation,
  type RuleSecretSnapshot,
  type SessionResult,
  type SessionRules,
} from "@drawbackengine/chess-core";
import type { ChessMove } from "@drawbackengine/drawback-engine";
import { Mulberry32, type PlayerColor, type RandomSource } from "@drawbackengine/shared";

export interface AgentView {
  readonly color: PlayerColor;
  readonly fen: string;
  readonly ply: number;
  readonly legalMoves: readonly ChessMove[];
  readonly history: readonly ChessMove[];
}

export interface SimulationAgent {
  readonly id: string;
  readonly style?: string;
  readonly strength?: number;
  chooseMove(view: AgentView, rng: RandomSource): ChessMove;
}

export interface SimulationAgentSnapshot {
  readonly id: string;
  readonly style: string | null;
  readonly strength: number | null;
}

export interface SimulationConfig<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
> {
  readonly seed: number;
  readonly rules: SessionRules<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters
  >;
  readonly whiteAgent: SimulationAgent;
  readonly blackAgent: SimulationAgent;
  readonly maxPlies?: number;
  readonly fen?: string;
}

export interface SimulationPly {
  readonly ply: number;
  readonly color: PlayerColor;
  readonly observation: MoveObservation;
  readonly drawback: RuleSecretSnapshot<unknown, unknown>;
}

export interface HiddenDrawbackReveal {
  readonly white: string;
  readonly black: string;
}

export interface SimulationResult {
  readonly seed: number;
  readonly result: SessionResult;
  readonly plies: readonly SimulationPly[];
  readonly finalFen: string;
  readonly drawbacks: HiddenDrawbackReveal;
  readonly agents: {
    readonly white: SimulationAgentSnapshot;
    readonly black: SimulationAgentSnapshot;
  };
  readonly stoppedAtPlyLimit: boolean;
}

const DEFAULT_MAX_PLIES = 300;

export const randomLegalAgent: SimulationAgent = {
  id: "random-legal",
  style: "random",
  strength: 100,
  chooseMove(view, rng) {
    if (view.legalMoves.length === 0) {
      throw new Error("Random legal agent was asked to move without a legal move.");
    }
    const selected = view.legalMoves[rng.integer(view.legalMoves.length)];
    if (selected === undefined) {
      throw new Error("Random source selected an out-of-range legal move.");
    }
    return selected;
  },
};

function toCommand(move: ChessMove): MoveCommand {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion === undefined ? {} : { promotion: move.promotion }),
  };
}

export function simulateGame<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
>(
  config: SimulationConfig<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters
  >,
): SimulationResult {
  const maxPlies = config.maxPlies ?? DEFAULT_MAX_PLIES;
  if (!Number.isSafeInteger(maxPlies) || maxPlies <= 0) {
    throw new RangeError("maxPlies must be a positive safe integer.");
  }

  const rng = new Mulberry32(config.seed);
  const session = new GameSession(config.rules, rng, config.fen);
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
    const selected = agent.chooseMove(
      {
        color,
        fen: session.fen,
        ply: plies.length,
        legalMoves: [...legalMoves],
        history: session.history(),
      },
      rng,
    );
    const outcome = session.move(toCommand(selected));
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
