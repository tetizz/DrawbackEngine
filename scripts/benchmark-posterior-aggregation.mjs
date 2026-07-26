import console from "node:console";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  advancePublicGameTrace,
  createPublicGameTrace,
  DrawbackGameSession,
  inspectPublicGameTrace,
  publicGameTraceView,
} from "../packages/chess-core/dist/index.js";
import {
  createOwnPlayerRuleCapability,
  drawbackMaterialEvaluator,
  searchOmniscientDrawbackRootMove,
  searchPlayerPrivateDrawbackMove,
} from "../packages/drawback-search/dist/index.js";
import {
  auditedUniformOpponentHypotheses,
  createSimulationRandomStreams,
  resolvePlayerPrivateRule,
} from "../packages/simulation-arena/dist/index.js";
import {
  parsePlayerPrivateSimulationTraceRecord,
} from "../packages/simulation-trace/dist/index.js";
import {
  createPosteriorBenchmarkReport,
} from "./posterior-benchmark-report.mjs";

const argumentsWithoutCommand = process.argv.slice(2);
if (argumentsWithoutCommand[0] === "--") {
  argumentsWithoutCommand.shift();
}
const [
  inputArgument,
  startArgument = "30",
  countArgument = "30",
  plyArgument = "8",
  depthArgument = "2",
  nodesArgument = "10000",
] = process.argv.slice(2);

if (inputArgument === undefined) {
  throw new TypeError(
    "Usage: node scripts/benchmark-posterior-aggregation.mjs "
      + "<validation.ndjson> [startGameIndex] [count] [ply] [depth] [nodes]",
  );
}

const inputPath = resolve(inputArgument);
const startGameIndex = nonNegativeInteger(
  startArgument,
  "startGameIndex",
);
const count = positiveInteger(countArgument, "count");
const targetPly = nonNegativeInteger(plyArgument, "ply");
const depth = positiveInteger(depthArgument, "depth");
const maxNodes = positiveInteger(nodesArgument, "nodes");
const records = (await readFile(inputPath, "utf8"))
  .split(/\r?\n/u)
  .filter((line) => line.length > 0)
  .map((line) =>
    parsePlayerPrivateSimulationTraceRecord(JSON.parse(line))
  )
  .filter(
    ({ gameIndex }) =>
      gameIndex >= startGameIndex
      && gameIndex < startGameIndex + count,
  )
  .sort((left, right) => left.gameIndex - right.gameIndex);

if (records.length !== count) {
  throw new RangeError(
    `Expected ${String(count)} records in the requested game-index range; `
      + `found ${String(records.length)}.`,
  );
}

const comparisons = [];
for (const record of records) {
  const positionPly = record.plies[targetPly];
  if (positionPly === undefined) {
    throw new RangeError(
      `Game ${String(record.gameIndex)} has no ply ${String(targetPly)}.`,
    );
  }
  const { trace, session } = reconstructPosition(record, targetPly);
  const color = session.turn;
  if (
    color !== positionPly.color
    || inspectPublicGameTrace(trace).current.fen
      !== positionPly.positionBefore.fen
  ) {
    throw new Error(
      `Game ${String(record.gameIndex)} reconstruction diverged.`,
    );
  }
  const rules = {
    white: resolvePlayerPrivateRule(
      record.secrets.initial.white.drawbackId,
    ),
    black: resolvePlayerPrivateRule(
      record.secrets.initial.black.drawbackId,
    ),
  };
  const secret = session.exportSecretSnapshot()[color];
  const own = createOwnPlayerRuleCapability(
    "capturable-king/v1",
    color,
    rules[color],
    secret.parameters,
    secret.state,
    publicGameTraceView(trace),
  );
  const opponentColor = color === "white" ? "black" : "white";
  const opponent = await auditedUniformOpponentHypotheses.hypotheses({
    observerColor: color,
    opponentColor,
    trace,
  });
  const common = {
    trace,
    own,
    opponent,
    evaluator: drawbackMaterialEvaluator,
    limits: { depth, maxNodes },
  };
  const worstCase = await searchPlayerPrivateDrawbackMove({
    ...common,
    aggregation: "worst-case",
  });
  const posteriorExpected = await searchPlayerPrivateDrawbackMove({
    ...common,
    aggregation: "posterior-expected",
  });
  const posteriorCvar = await searchPlayerPrivateDrawbackMove({
    ...common,
    aggregation: "posterior-cvar-25",
  });
  const oracleByMove = new Map();
  const oracleFor = async (move) => {
    const id = moveId(move);
    const cached = oracleByMove.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const result = await searchOmniscientDrawbackRootMove(
      session,
      move,
      drawbackMaterialEvaluator,
      { depth, maxNodes },
    );
    oracleByMove.set(id, result);
    return result;
  };
  const worstCaseOracle = await oracleFor(worstCase.move);
  const posteriorExpectedOracle = await oracleFor(posteriorExpected.move);
  const posteriorCvarOracle = await oracleFor(posteriorCvar.move);
  comparisons.push({
    gameIndex: record.gameIndex,
    ply: targetPly,
    color,
    hypothesisCount: opponent.length,
    worstCaseMove: moveId(worstCase.move),
    posteriorExpectedMove: moveId(posteriorExpected.move),
    posteriorCvar25Move: moveId(posteriorCvar.move),
    worstCaseSearchScore: worstCase.score,
    posteriorExpectedSearchScore: posteriorExpected.score,
    posteriorCvar25SearchScore: posteriorCvar.score,
    worstCaseOracleScore: worstCaseOracle.score,
    posteriorExpectedOracleScore: posteriorExpectedOracle.score,
    posteriorCvar25OracleScore: posteriorCvarOracle.score,
    truncated:
      worstCase.truncated
      || posteriorExpected.truncated
      || posteriorCvar.truncated
      || worstCaseOracle.truncated
      || posteriorExpectedOracle.truncated
      || posteriorCvarOracle.truncated,
  });
  console.error(
    `benchmarked game ${String(record.gameIndex)} at ply `
      + `${String(targetPly)}`,
  );
}

console.log(JSON.stringify(createPosteriorBenchmarkReport({
  inputPath,
  startGameIndex,
  count,
  targetPly,
  depth,
  maxNodes,
  comparisons,
}), null, 2));

function reconstructPosition(record, target) {
  const rules = {
    white: resolvePlayerPrivateRule(
      record.secrets.initial.white.drawbackId,
    ),
    black: resolvePlayerPrivateRule(
      record.secrets.initial.black.drawbackId,
    ),
  };
  const random = createSimulationRandomStreams(
    record.seed,
    record.parameterSeeds,
  );
  const session = DrawbackGameSession.create(
    rules,
    random.parameters,
    record.initialPosition.fen,
  );
  const reconstructedSecrets = session.exportSecretSnapshot();
  if (
    !sameTraceSecret(
      reconstructedSecrets.white,
      record.secrets.initial.white,
    )
    || !sameTraceSecret(
      reconstructedSecrets.black,
      record.secrets.initial.black,
    )
  ) {
    throw new Error(
      `Game ${String(record.gameIndex)} initial secret reconstruction diverged.`,
    );
  }
  let trace = createPublicGameTrace(record.initialPosition);
  for (let index = 0; index < target; index += 1) {
    const ply = record.plies[index];
    if (ply === undefined) {
      throw new RangeError(
        `Game ${String(record.gameIndex)} has no replay ply ${String(index)}.`,
      );
    }
    const command = commandFromUci(ply.move.uci);
    trace = advancePublicGameTrace(trace, command);
    const outcome = session.move(command);
    if (!outcome.ok) {
      throw new Error(
        `Game ${String(record.gameIndex)} exact replay rejected ply `
          + `${String(index)}: ${outcome.message}`,
      );
    }
  }
  if (session.result.kind !== "active") {
    throw new Error(
      `Game ${String(record.gameIndex)} is terminal before the benchmark ply.`,
    );
  }
  return { trace, session };
}

function sameTraceSecret(actual, expected) {
  return (
    actual.drawbackId === expected.drawbackId
    && isDeepStrictEqual(
      actual.parameters,
      expected.hiddenParameters,
    )
    && isDeepStrictEqual(
      actual.state,
      expected.drawbackInternalState,
    )
  );
}

function commandFromUci(uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(uci)) {
    throw new TypeError(`Invalid UCI move: ${String(uci)}.`);
  }
  const promotion = uci[4];
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(promotion === undefined
      ? {}
      : {
          promotion: {
            q: "queen",
            r: "rook",
            b: "bishop",
            n: "knight",
          }[promotion],
        }),
  };
}

function moveId(move) {
  const promotion = move.promotion?.[0] ?? "";
  return `${move.from}${move.to}${promotion}`;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}
