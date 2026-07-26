export type PlayerColor = "white" | "black";

export interface RandomSource {
  next(): number;
  integer(maxExclusive: number): number;
}

export class Mulberry32 implements RandomSource {
  readonly #initialSeed: number;
  #state: number;

  public constructor(seed: number) {
    this.#initialSeed = seed >>> 0;
    this.#state = this.#initialSeed;
  }

  public get seed(): number {
    return this.#initialSeed;
  }

  public next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  public integer(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError("maxExclusive must be a positive safe integer");
    }
    return Math.floor(this.next() * maxExclusive);
  }
}

export function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

export {
  deriveSimulationStreamSeed,
  SIMULATION_RANDOM_POLICY,
  SIMULATION_RANDOM_STREAM_DOMAINS,
} from "./simulation-random.js";
