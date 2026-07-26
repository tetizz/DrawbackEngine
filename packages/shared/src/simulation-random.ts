export const SIMULATION_RANDOM_POLICY = Object.freeze({
  kind: "explicit-parameter-seeds-domain-agent-mulberry32" as const,
  version: 1 as const,
});

export const SIMULATION_RANDOM_STREAM_DOMAINS = Object.freeze({
  whiteParameters: 0x4f1b_bcdd,
  blackParameters: 0x9d76_8a41,
  whiteAgent: 0x2c92_7f35,
  blackAgent: 0xe5a4_1c6b,
});

const MAX_UNSIGNED_32_BIT_INTEGER = 0xffff_ffff;

/**
 * Deterministically derives one purpose-separated PRNG seed.
 *
 * This algorithm is part of the serialized simulation provenance contract.
 * Changing it requires a new simulation random-policy version.
 */
export function deriveSimulationStreamSeed(
  seed: number,
  domain: number,
  index: number,
): number {
  assertUnsignedSeed(seed, "seed");
  assertUnsignedSeed(domain, "domain");
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("index must be a non-negative safe integer.");
  }
  let value =
    (seed ^ domain ^ Math.imul((index + 1) >>> 0, 0x9e37_79b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0_aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a_2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

function assertUnsignedSeed(value: number, name: string): void {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_UNSIGNED_32_BIT_INTEGER
  ) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer.`);
  }
}
