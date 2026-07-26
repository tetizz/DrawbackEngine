export function simulationGameId(seed: number, gameIndex: number): string {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("Simulation seed must be an unsigned 32-bit integer.");
  }
  if (!Number.isSafeInteger(gameIndex) || gameIndex < 0) {
    throw new RangeError("Simulation game index must be a non-negative safe integer.");
  }
  return `${seed.toString(16).padStart(8, "0")}-${String(gameIndex).padStart(6, "0")}`;
}
