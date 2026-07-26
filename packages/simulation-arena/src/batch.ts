import type { SimulationConfig, SimulationResult } from "./simulation.js";
import { simulateGame } from "./simulation.js";
import {
  simulateCatalogGame,
  type CatalogSelectionOptions,
} from "./catalog.js";

export interface BatchConfig<
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
    "seed"
  > {
  readonly seed: number;
  readonly games: number;
}

export function deriveGameSeed(batchSeed: number, gameIndex: number): number {
  if (!Number.isSafeInteger(gameIndex) || gameIndex < 0) {
    throw new RangeError("gameIndex must be a non-negative safe integer.");
  }
  let value = (batchSeed ^ Math.imul(gameIndex + 1, 0x9e37_79b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x21f0_aaad);
  value ^= value >>> 15;
  value = Math.imul(value, 0x735a_2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

export function simulateBatch<
  WhiteState,
  WhiteParameters,
  BlackState,
  BlackParameters,
>(
  config: BatchConfig<
    WhiteState,
    WhiteParameters,
    BlackState,
    BlackParameters
  >,
): readonly SimulationResult[] {
  if (!Number.isSafeInteger(config.games) || config.games <= 0) {
    throw new RangeError("games must be a positive safe integer.");
  }
  return Array.from({ length: config.games }, (_, gameIndex) =>
    simulateGame({
      seed: deriveGameSeed(config.seed, gameIndex),
      rules: config.rules,
      whiteAgent: config.whiteAgent,
      blackAgent: config.blackAgent,
      ...(config.maxPlies === undefined ? {} : { maxPlies: config.maxPlies }),
      ...(config.fen === undefined ? {} : { fen: config.fen }),
    }),
  );
}

export interface CatalogBatchConfig extends CatalogSelectionOptions {
  readonly seed: number;
  readonly games: number;
}

export function simulateCatalogBatch(
  config: CatalogBatchConfig,
): readonly SimulationResult[] {
  if (!Number.isSafeInteger(config.games) || config.games <= 0) {
    throw new RangeError("games must be a positive safe integer.");
  }
  return Array.from({ length: config.games }, (_, gameIndex) =>
    simulateCatalogGame(deriveGameSeed(config.seed, gameIndex), config),
  );
}
