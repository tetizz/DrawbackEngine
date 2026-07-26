import {
  deriveSimulationStreamSeed,
  Mulberry32,
  SIMULATION_RANDOM_STREAM_DOMAINS,
  type PlayerColor,
  type RandomSource,
} from "@drawbackengine/shared";
import type {
  SessionParameterRandomSources,
} from "@drawbackengine/chess-core";

const MAX_UNSIGNED_32_BIT_INTEGER = 0xffff_ffff;

export interface SimulationRandomStreams {
  readonly parameterSeeds: SimulationParameterSeeds;
  readonly parameters: SessionParameterRandomSources;
  agent(color: PlayerColor, ply: number): RandomSource;
}

export interface SimulationParameterSeeds {
  readonly white: number;
  readonly black: number;
}

/**
 * Derives independent deterministic streams from a serialized game seed.
 *
 * Parameter generators and agents cannot shift one another's future random
 * draws. This prevents hidden-label RNG consumption from becoming a learned
 * shortcut in generated training data.
 */
export function createSimulationRandomStreams(
  seed: number,
  parameterSeeds?: SimulationParameterSeeds,
): SimulationRandomStreams {
  checkedSeed(seed);
  const resolvedParameterSeeds = Object.freeze({
    white:
      parameterSeeds?.white
      ?? deriveSimulationStreamSeed(
        seed,
        SIMULATION_RANDOM_STREAM_DOMAINS.whiteParameters,
        0,
      ),
    black:
      parameterSeeds?.black
      ?? deriveSimulationStreamSeed(
        seed,
        SIMULATION_RANDOM_STREAM_DOMAINS.blackParameters,
        0,
      ),
  });
  checkedSeed(resolvedParameterSeeds.white);
  checkedSeed(resolvedParameterSeeds.black);
  return Object.freeze({
    parameterSeeds: resolvedParameterSeeds,
    parameters: Object.freeze({
      white: new Mulberry32(resolvedParameterSeeds.white),
      black: new Mulberry32(resolvedParameterSeeds.black),
    }),
    agent(color: PlayerColor, ply: number) {
      if (!Number.isSafeInteger(ply) || ply < 0) {
        throw new RangeError("ply must be a non-negative safe integer.");
      }
      const domain =
        color === "white"
          ? SIMULATION_RANDOM_STREAM_DOMAINS.whiteAgent
          : SIMULATION_RANDOM_STREAM_DOMAINS.blackAgent;
      return new Mulberry32(
        deriveSimulationStreamSeed(seed, domain, ply),
      );
    },
  });
}

function checkedSeed(seed: number): void {
  if (
    !Number.isSafeInteger(seed)
    || seed < 0
    || seed > MAX_UNSIGNED_32_BIT_INTEGER
  ) {
    throw new RangeError("seed must be an unsigned 32-bit integer.");
  }
}
