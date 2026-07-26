import {
  Mulberry32,
  type PlayerColor,
  type RandomSource,
} from "@drawbackengine/shared";
import type {
  SessionParameterRandomSources,
} from "@drawbackengine/chess-core";

const MAX_UNSIGNED_32_BIT_INTEGER = 0xffff_ffff;
const STREAM_DOMAINS = {
  whiteParameters: 0x4f1b_bcdd,
  blackParameters: 0x9d76_8a41,
  whiteAgent: 0x2c92_7f35,
  blackAgent: 0xe5a4_1c6b,
} as const;

export interface SimulationRandomStreams {
  readonly parameters: SessionParameterRandomSources;
  agent(color: PlayerColor, ply: number): RandomSource;
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
): SimulationRandomStreams {
  checkedSeed(seed);
  return Object.freeze({
    parameters: Object.freeze({
      white: new Mulberry32(deriveStreamSeed(seed, STREAM_DOMAINS.whiteParameters, 0)),
      black: new Mulberry32(deriveStreamSeed(seed, STREAM_DOMAINS.blackParameters, 0)),
    }),
    agent(color: PlayerColor, ply: number) {
      if (!Number.isSafeInteger(ply) || ply < 0) {
        throw new RangeError("ply must be a non-negative safe integer.");
      }
      const domain =
        color === "white"
          ? STREAM_DOMAINS.whiteAgent
          : STREAM_DOMAINS.blackAgent;
      return new Mulberry32(deriveStreamSeed(seed, domain, ply));
    },
  });
}

function deriveStreamSeed(
  seed: number,
  domain: number,
  index: number,
): number {
  let value =
    (seed ^ domain ^ Math.imul((index + 1) >>> 0, 0x9e37_79b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0_aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a_2d97);
  return (value ^ (value >>> 15)) >>> 0;
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
