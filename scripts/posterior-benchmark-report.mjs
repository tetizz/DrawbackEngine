import { isDeepStrictEqual } from "node:util";

const REPORT_KEYS = [
  "inputPath",
  "startGameIndex",
  "count",
  "targetPly",
  "depth",
  "maxNodes",
  "completePositions",
  "truncatedPositions",
  "posteriorExpected",
  "posteriorCvar25",
  "comparisons",
];
const SUMMARY_KEYS = [
  "differingMoves",
  "candidateOracleWins",
  "worstCaseOracleWins",
  "equalOracleScoresOnDifferingMoves",
  "meanCandidateMinusWorstCaseOracleCp",
];
const COMPARISON_KEYS = [
  "gameIndex",
  "ply",
  "color",
  "hypothesisCount",
  "worstCaseMove",
  "posteriorExpectedMove",
  "posteriorCvar25Move",
  "worstCaseSearchScore",
  "posteriorExpectedSearchScore",
  "posteriorCvar25SearchScore",
  "worstCaseOracleScore",
  "posteriorExpectedOracleScore",
  "posteriorCvar25OracleScore",
  "truncated",
];
const MOVE_ID = /^[a-h][1-8][a-h][1-8][qrbn]?$/u;

export function createPosteriorBenchmarkReport({
  inputPath,
  startGameIndex,
  count,
  targetPly,
  depth,
  maxNodes,
  comparisons,
}) {
  const checkedInputPath = nonEmptyString(inputPath, "inputPath");
  const checkedStart = nonNegativeInteger(
    startGameIndex,
    "startGameIndex",
  );
  const checkedCount = positiveInteger(count, "count");
  const checkedPly = nonNegativeInteger(targetPly, "targetPly");
  const checkedDepth = positiveInteger(depth, "depth");
  const checkedNodes = positiveInteger(maxNodes, "maxNodes");
  const checkedComparisons = comparisons.map(
    (comparison, index) => parseComparison(comparison, `comparisons[${index}]`),
  );
  if (checkedComparisons.length !== checkedCount) {
    throw new RangeError(
      `Expected ${String(checkedCount)} comparisons; found `
        + `${String(checkedComparisons.length)}.`,
    );
  }
  const expectedIndexes = Array.from(
    { length: checkedCount },
    (_unused, offset) => checkedStart + offset,
  );
  if (
    !isDeepStrictEqual(
      checkedComparisons.map(({ gameIndex }) => gameIndex),
      expectedIndexes,
    )
  ) {
    throw new RangeError(
      "Comparisons must be ordered and cover the declared game range.",
    );
  }
  if (checkedComparisons.some(({ ply }) => ply !== checkedPly)) {
    throw new TypeError("A comparison uses the wrong target ply.");
  }
  const complete = checkedComparisons.filter(({ truncated }) => !truncated);
  return {
    inputPath: checkedInputPath,
    startGameIndex: checkedStart,
    count: checkedCount,
    targetPly: checkedPly,
    depth: checkedDepth,
    maxNodes: checkedNodes,
    completePositions: complete.length,
    truncatedPositions: checkedComparisons.length - complete.length,
    posteriorExpected: summarizeCandidate(
      complete,
      "posteriorExpectedMove",
      "posteriorExpectedOracleScore",
    ),
    posteriorCvar25: summarizeCandidate(
      complete,
      "posteriorCvar25Move",
      "posteriorCvar25OracleScore",
    ),
    comparisons: checkedComparisons,
  };
}

export function parsePosteriorBenchmarkReport(value, path = "report") {
  const object = exactObject(value, REPORT_KEYS, path);
  const comparisons = arrayAt(object.comparisons, `${path}.comparisons`).map(
    (comparison, index) =>
      parseComparison(comparison, `${path}.comparisons[${index}]`),
  );
  const rebuilt = createPosteriorBenchmarkReport({
    inputPath: nonEmptyString(object.inputPath, `${path}.inputPath`),
    startGameIndex: nonNegativeInteger(
      object.startGameIndex,
      `${path}.startGameIndex`,
    ),
    count: positiveInteger(object.count, `${path}.count`),
    targetPly: nonNegativeInteger(object.targetPly, `${path}.targetPly`),
    depth: positiveInteger(object.depth, `${path}.depth`),
    maxNodes: positiveInteger(object.maxNodes, `${path}.maxNodes`),
    comparisons,
  });
  const suppliedExpected = parseSummary(
    object.posteriorExpected,
    `${path}.posteriorExpected`,
  );
  const suppliedCvar = parseSummary(
    object.posteriorCvar25,
    `${path}.posteriorCvar25`,
  );
  if (
    object.completePositions !== rebuilt.completePositions
    || object.truncatedPositions !== rebuilt.truncatedPositions
    || !isDeepStrictEqual(suppliedExpected, rebuilt.posteriorExpected)
    || !isDeepStrictEqual(suppliedCvar, rebuilt.posteriorCvar25)
  ) {
    throw new TypeError(`${path} derived summary is inconsistent.`);
  }
  return rebuilt;
}

export function combinePosteriorBenchmarkReports(reports, expected) {
  const parsed = reports.map((report, index) =>
    parsePosteriorBenchmarkReport(report, `reports[${index}]`)
  );
  if (parsed.length === 0) {
    throw new RangeError("At least one benchmark shard is required.");
  }
  const inputPath = nonEmptyString(expected.inputPath, "expected.inputPath");
  const startGameIndex = nonNegativeInteger(
    expected.startGameIndex,
    "expected.startGameIndex",
  );
  const count = positiveInteger(expected.count, "expected.count");
  const targetPly = nonNegativeInteger(
    expected.targetPly,
    "expected.targetPly",
  );
  const depth = positiveInteger(expected.depth, "expected.depth");
  const maxNodes = positiveInteger(expected.maxNodes, "expected.maxNodes");
  const comparisons = [];
  for (const [index, report] of parsed.entries()) {
    if (
      report.inputPath !== inputPath
      || report.targetPly !== targetPly
      || report.depth !== depth
      || report.maxNodes !== maxNodes
    ) {
      throw new TypeError(
        `reports[${String(index)}] benchmark parameters do not match.`,
      );
    }
    comparisons.push(...report.comparisons);
  }
  comparisons.sort((left, right) => left.gameIndex - right.gameIndex);
  const expectedIndexes = Array.from(
    { length: count },
    (_unused, offset) => startGameIndex + offset,
  );
  const actualIndexes = comparisons.map(({ gameIndex }) => gameIndex);
  if (!isDeepStrictEqual(actualIndexes, expectedIndexes)) {
    throw new RangeError(
      "Benchmark shards must cover every expected game index exactly once.",
    );
  }
  if (comparisons.some(({ ply }) => ply !== targetPly)) {
    throw new TypeError("A shard comparison uses the wrong target ply.");
  }
  return createPosteriorBenchmarkReport({
    inputPath,
    startGameIndex,
    count,
    targetPly,
    depth,
    maxNodes,
    comparisons,
  });
}

function summarizeCandidate(records, moveField, scoreField) {
  const differing = records.filter(
    (record) => record.worstCaseMove !== record[moveField],
  );
  const candidateWins = differing.filter(
    (record) => record[scoreField] > record.worstCaseOracleScore,
  );
  const worstCaseWins = differing.filter(
    (record) => record[scoreField] < record.worstCaseOracleScore,
  );
  return {
    differingMoves: differing.length,
    candidateOracleWins: candidateWins.length,
    worstCaseOracleWins: worstCaseWins.length,
    equalOracleScoresOnDifferingMoves:
      differing.length - candidateWins.length - worstCaseWins.length,
    meanCandidateMinusWorstCaseOracleCp:
      records.length === 0
        ? null
        : records.reduce(
            (total, record) =>
              total + record[scoreField] - record.worstCaseOracleScore,
            0,
          ) / records.length,
  };
}

function parseSummary(value, path) {
  const object = exactObject(value, SUMMARY_KEYS, path);
  return {
    differingMoves: nonNegativeInteger(
      object.differingMoves,
      `${path}.differingMoves`,
    ),
    candidateOracleWins: nonNegativeInteger(
      object.candidateOracleWins,
      `${path}.candidateOracleWins`,
    ),
    worstCaseOracleWins: nonNegativeInteger(
      object.worstCaseOracleWins,
      `${path}.worstCaseOracleWins`,
    ),
    equalOracleScoresOnDifferingMoves: nonNegativeInteger(
      object.equalOracleScoresOnDifferingMoves,
      `${path}.equalOracleScoresOnDifferingMoves`,
    ),
    meanCandidateMinusWorstCaseOracleCp:
      object.meanCandidateMinusWorstCaseOracleCp === null
        ? null
        : finiteNumber(
            object.meanCandidateMinusWorstCaseOracleCp,
            `${path}.meanCandidateMinusWorstCaseOracleCp`,
          ),
  };
}

function parseComparison(value, path) {
  const object = exactObject(value, COMPARISON_KEYS, path);
  const color = object.color;
  if (color !== "white" && color !== "black") {
    throw new TypeError(`${path}.color must be white or black.`);
  }
  return {
    gameIndex: nonNegativeInteger(object.gameIndex, `${path}.gameIndex`),
    ply: nonNegativeInteger(object.ply, `${path}.ply`),
    color,
    hypothesisCount: positiveInteger(
      object.hypothesisCount,
      `${path}.hypothesisCount`,
    ),
    worstCaseMove: moveId(object.worstCaseMove, `${path}.worstCaseMove`),
    posteriorExpectedMove: moveId(
      object.posteriorExpectedMove,
      `${path}.posteriorExpectedMove`,
    ),
    posteriorCvar25Move: moveId(
      object.posteriorCvar25Move,
      `${path}.posteriorCvar25Move`,
    ),
    worstCaseSearchScore: finiteNumber(
      object.worstCaseSearchScore,
      `${path}.worstCaseSearchScore`,
    ),
    posteriorExpectedSearchScore: finiteNumber(
      object.posteriorExpectedSearchScore,
      `${path}.posteriorExpectedSearchScore`,
    ),
    posteriorCvar25SearchScore: finiteNumber(
      object.posteriorCvar25SearchScore,
      `${path}.posteriorCvar25SearchScore`,
    ),
    worstCaseOracleScore: finiteNumber(
      object.worstCaseOracleScore,
      `${path}.worstCaseOracleScore`,
    ),
    posteriorExpectedOracleScore: finiteNumber(
      object.posteriorExpectedOracleScore,
      `${path}.posteriorExpectedOracleScore`,
    ),
    posteriorCvar25OracleScore: finiteNumber(
      object.posteriorCvar25OracleScore,
      `${path}.posteriorCvar25OracleScore`,
    ),
    truncated: booleanAt(object.truncated, `${path}.truncated`),
  };
}

function exactObject(value, keys, path) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${path} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new TypeError(`${path} has invalid fields.`);
  }
  return value;
}

function arrayAt(value, path) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array.`);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

function moveId(value, path) {
  const parsed = nonEmptyString(value, path);
  if (!MOVE_ID.test(parsed)) {
    throw new TypeError(`${path} must be a coordinate move ID.`);
  }
  return parsed;
}

function finiteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite.`);
  }
  return value;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive safe integer.`);
  }
  return value;
}

function booleanAt(value, path) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be boolean.`);
  }
  return value;
}
