import type { SimulationResult } from "@drawbackengine/simulation-arena";

export interface TextOutput {
  write(chunk: string): unknown;
}

/**
 * Writes one complete trusted-engine game trace per line.
 *
 * These traces include the post-game drawback reveal. They are intended for
 * local engine diagnostics, not for a player-facing observation stream.
 */
export function writeSimulationTraceNdjson(
  games: readonly SimulationResult[],
  output: TextOutput,
): number {
  for (const game of games) {
    output.write(`${JSON.stringify(game)}\n`);
  }
  return games.length;
}
