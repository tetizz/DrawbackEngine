import {
  checkersRule,
  veganRule,
} from "@drawbackengine/drawback-engine";
import { randomLegalAgent, simulateGame } from "@drawbackengine/simulation-arena";

function parseSeed(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("Seed must be an integer from 0 through 4294967295.");
  }
  return seed;
}

function main(): void {
  const seed = parseSeed(process.argv.slice(2).find((argument) => argument !== "--"));
  const game = simulateGame({
    seed,
    maxPlies: 120,
    rules: {
      white: veganRule,
      black: checkersRule,
    },
    whiteAgent: randomLegalAgent,
    blackAgent: randomLegalAgent,
  });

  console.log(`DrawbackEngine deterministic simulation (seed ${String(seed)})`);
  for (const ply of game.plies) {
    const moveNumber = Math.floor(ply.ply / 2) + 1;
    const prefix =
      ply.color === "white"
        ? `${String(moveNumber)}.`
        : `${String(moveNumber)}...`;
    console.log(`${prefix} ${ply.observation.move.san}`);
  }
  console.log(
    game.stoppedAtPlyLimit
      ? `Stopped at the ${String(game.plies.length)}-ply safety limit.`
      : `Result: ${JSON.stringify(game.result)}`,
  );
  console.log(
    `Post-game reveal: White=${game.drawbacks.white}, Black=${game.drawbacks.black}`,
  );
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown simulator error.";
  console.error(`Simulation failed: ${message}`);
  process.exitCode = 1;
}
