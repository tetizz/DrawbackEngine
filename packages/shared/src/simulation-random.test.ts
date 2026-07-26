import { describe, expect, it } from "vitest";
import {
  deriveSimulationStreamSeed,
  SIMULATION_RANDOM_STREAM_DOMAINS,
} from "./simulation-random.js";

describe("simulation random stream provenance", () => {
  it("is deterministic and separates purpose, color, and ply", () => {
    const seed = 0x1234_5678;
    const whiteParameters = deriveSimulationStreamSeed(
      seed,
      SIMULATION_RANDOM_STREAM_DOMAINS.whiteParameters,
      0,
    );
    expect(deriveSimulationStreamSeed(
      seed,
      SIMULATION_RANDOM_STREAM_DOMAINS.whiteParameters,
      0,
    )).toBe(whiteParameters);
    expect(new Set([
      whiteParameters,
      deriveSimulationStreamSeed(
        seed,
        SIMULATION_RANDOM_STREAM_DOMAINS.blackParameters,
        0,
      ),
      deriveSimulationStreamSeed(
        seed,
        SIMULATION_RANDOM_STREAM_DOMAINS.whiteAgent,
        0,
      ),
      deriveSimulationStreamSeed(
        seed,
        SIMULATION_RANDOM_STREAM_DOMAINS.whiteAgent,
        1,
      ),
    ]).size).toBe(4);
  });

  it("rejects values outside the serialized policy domain", () => {
    expect(() => deriveSimulationStreamSeed(-1, 0, 0)).toThrow(
      "seed must be an unsigned 32-bit integer",
    );
    expect(() => deriveSimulationStreamSeed(0, 0, -1)).toThrow(
      "index must be a non-negative safe integer",
    );
  });
});
