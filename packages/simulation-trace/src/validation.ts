import { simulationGameId } from "./game-id.js";
import {
  agentAt,
  constraintAt,
  resultAt,
  UCI_MOVE_PATTERN,
} from "./field-parsers.js";
import {
  booleanAt,
  colorAt,
  exactKeys,
  jsonValueAt,
  objectAt,
  safeIntegerAt,
  stringAt,
  stringListAt,
} from "./parse-primitives.js";
import { validatePublicReplay } from "./semantic-replay.js";
import {
  PRIVATE_SIMULATION_TRACE_FORMAT,
  PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
  type PrivateSimulationTracePly,
  type PrivateSimulationTraceRecord,
} from "./types.js";

function plyAt(
  value: unknown,
  index: number,
  path: string,
): PrivateSimulationTracePly {
  const object = objectAt(value, path);
  exactKeys(
    object,
    [
      "ply",
      "color",
      "fenBefore",
      "fenAfter",
      "move",
      "ordinaryLegalMoves",
      "drawbackLegalMoves",
      "ruleTriggered",
      "forced",
      "publicEvaluatorConstraint",
      "activeSecret",
    ],
    [],
    path,
  );
  const ply = safeIntegerAt(object.ply, `${path}.ply`);
  if (ply !== index) {
    throw new TypeError(`${path}.ply must equal its zero-based array index.`);
  }
  const color = colorAt(object.color, `${path}.color`);
  const move = objectAt(object.move, `${path}.move`);
  exactKeys(move, ["uci", "san"], [], `${path}.move`);
  const activeSecret = objectAt(object.activeSecret, `${path}.activeSecret`);
  exactKeys(
    activeSecret,
    ["drawbackId", "hiddenParameters", "drawbackInternalState"],
    [],
    `${path}.activeSecret`,
  );
  const drawbackId = stringAt(
    activeSecret.drawbackId,
    `${path}.activeSecret.drawbackId`,
  );
  const uci = stringAt(move.uci, `${path}.move.uci`);
  if (!UCI_MOVE_PATTERN.test(uci)) {
    throw new TypeError(`${path}.move.uci must be a standard UCI move.`);
  }
  const ordinaryLegalMoves = [...stringListAt(
    object.ordinaryLegalMoves,
    `${path}.ordinaryLegalMoves`,
  )].sort();
  const drawbackLegalMoves = [...stringListAt(
    object.drawbackLegalMoves,
    `${path}.drawbackLegalMoves`,
  )].sort();
  for (const [list, listPath] of [
    [ordinaryLegalMoves, `${path}.ordinaryLegalMoves`],
    [drawbackLegalMoves, `${path}.drawbackLegalMoves`],
  ] as const) {
    if (new Set(list).size !== list.length) {
      throw new TypeError(`${listPath} must not contain duplicate moves.`);
    }
    if (list.some((candidate) => !UCI_MOVE_PATTERN.test(candidate))) {
      throw new TypeError(`${listPath} must contain only standard UCI moves.`);
    }
  }
  const ordinarySet = new Set(ordinaryLegalMoves);
  if (drawbackLegalMoves.some((candidate) => !ordinarySet.has(candidate))) {
    throw new TypeError(
      `${path}.drawbackLegalMoves must be a subset of ordinaryLegalMoves.`,
    );
  }
  if (!drawbackLegalMoves.includes(uci)) {
    throw new TypeError(`${path}.move.uci must be drawback-legal.`);
  }
  const ruleTriggered = booleanAt(
    object.ruleTriggered,
    `${path}.ruleTriggered`,
  );
  if (ruleTriggered !== (ordinaryLegalMoves.length !== drawbackLegalMoves.length)) {
    throw new TypeError(`${path}.ruleTriggered does not match the legal masks.`);
  }
  const forced = booleanAt(object.forced, `${path}.forced`);
  if (forced !== (drawbackLegalMoves.length === 1)) {
    throw new TypeError(`${path}.forced does not match the drawback-legal mask.`);
  }
  const fenBefore = stringAt(object.fenBefore, `${path}.fenBefore`);
  const fenTurn = fenBefore.split(" ")[1];
  if (
    (color === "white" && fenTurn !== "w")
    || (color === "black" && fenTurn !== "b")
  ) {
    throw new TypeError(`${path}.color must match the FEN side to move.`);
  }
  const publicEvaluatorConstraint =
    object.publicEvaluatorConstraint === null
      ? null
      : constraintAt(
          object.publicEvaluatorConstraint,
          `${path}.publicEvaluatorConstraint`,
        );
  if (
    publicEvaluatorConstraint !== null
    && !ordinarySet.has(publicEvaluatorConstraint.bestMoveUci)
  ) {
    throw new TypeError(
      `${path}.publicEvaluatorConstraint.bestMoveUci must be ordinary-legal.`,
    );
  }
  return {
    ply,
    color,
    fenBefore,
    fenAfter: stringAt(object.fenAfter, `${path}.fenAfter`),
    move: {
      uci,
      san: stringAt(move.san, `${path}.move.san`),
    },
    ordinaryLegalMoves,
    drawbackLegalMoves,
    ruleTriggered,
    forced,
    publicEvaluatorConstraint,
    activeSecret: {
      drawbackId,
      hiddenParameters: jsonValueAt(
        activeSecret.hiddenParameters,
        `${path}.activeSecret.hiddenParameters`,
      ),
      drawbackInternalState: jsonValueAt(
        activeSecret.drawbackInternalState,
        `${path}.activeSecret.drawbackInternalState`,
      ),
    },
  };
}

export function parsePrivateSimulationTraceRecord(
  value: unknown,
): PrivateSimulationTraceRecord {
  const object = objectAt(value, "trace");
  exactKeys(
    object,
    [
      "format",
      "schemaVersion",
      "authorityId",
      "gameIndex",
      "gameId",
      "seed",
      "plyLimit",
      "initialFen",
      "finalFen",
      "result",
      "stoppedAtPlyLimit",
      "evaluatorCoverage",
      "drawbacks",
      "agents",
      "plies",
    ],
    [],
    "trace",
  );
  if (object.format !== PRIVATE_SIMULATION_TRACE_FORMAT) {
    throw new TypeError("trace.format is unsupported.");
  }
  if (object.schemaVersion !== PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION) {
    throw new TypeError("trace.schemaVersion is unsupported.");
  }
  if (object.authorityId !== "standard-chess/v1") {
    throw new TypeError("trace.authorityId is unsupported.");
  }
  const gameIndex = safeIntegerAt(object.gameIndex, "trace.gameIndex");
  const seed = safeIntegerAt(object.seed, "trace.seed");
  if (seed > 0xffff_ffff) {
    throw new TypeError("trace.seed must be an unsigned 32-bit integer.");
  }
  if (!Array.isArray(object.plies)) {
    throw new TypeError("trace.plies must be an array.");
  }
  const plies = object.plies.map((entry, index) =>
    plyAt(entry, index, `trace.plies[${String(index)}]`));
  const plyLimit = safeIntegerAt(object.plyLimit, "trace.plyLimit", 1);
  if (plies.length > plyLimit) {
    throw new TypeError("trace.plies cannot exceed trace.plyLimit.");
  }
  const evaluatorCoverage = object.evaluatorCoverage;
  if (evaluatorCoverage !== "none" && evaluatorCoverage !== "uniform") {
    throw new TypeError(
      "trace.evaluatorCoverage must be none or uniform.",
    );
  }
  const constraints = plies.map((ply) => ply.publicEvaluatorConstraint);
  if (
    evaluatorCoverage === "none"
    && constraints.some((constraint) => constraint !== null)
  ) {
    throw new TypeError(
      "trace.evaluatorCoverage none forbids evaluator facts.",
    );
  }
  if (evaluatorCoverage === "uniform") {
    const first = constraints[0];
    if (first === undefined || first === null) {
      throw new TypeError(
        "trace.evaluatorCoverage uniform requires a fact on every ply.",
      );
    }
    if (
      constraints.some(
        (constraint) =>
          constraint === null
          || constraint.policyId !== first.policyId
          || constraint.engineFingerprint !== first.engineFingerprint,
      )
    ) {
      throw new TypeError(
        "trace.evaluatorCoverage uniform requires one policy and engine fingerprint.",
      );
    }
  }
  const initialFen = stringAt(object.initialFen, "trace.initialFen");
  const finalFen = stringAt(object.finalFen, "trace.finalFen");
  if (plies[0] !== undefined && plies[0].fenBefore !== initialFen) {
    throw new TypeError("trace.initialFen must equal the first ply FEN.");
  }
  for (let index = 1; index < plies.length; index += 1) {
    if (plies[index - 1]?.fenAfter !== plies[index]?.fenBefore) {
      throw new TypeError("trace.plies must contain one continuous FEN chain.");
    }
  }
  if (plies.at(-1) !== undefined && plies.at(-1)?.fenAfter !== finalFen) {
    throw new TypeError("trace.finalFen must equal the last ply FEN.");
  }
  if (plies.length === 0 && initialFen !== finalFen) {
    throw new TypeError(
      "A zero-ply trace must have identical initial and final FEN.",
    );
  }
  validatePublicReplay(initialFen, finalFen, plies);
  const drawbacks = objectAt(object.drawbacks, "trace.drawbacks");
  exactKeys(drawbacks, ["white", "black"], [], "trace.drawbacks");
  const agents = objectAt(object.agents, "trace.agents");
  exactKeys(agents, ["white", "black"], [], "trace.agents");
  const expectedGameId = simulationGameId(seed, gameIndex);
  if (object.gameId !== expectedGameId) {
    throw new TypeError("trace.gameId does not match the seed and game index.");
  }
  const whiteDrawback = stringAt(drawbacks.white, "trace.drawbacks.white");
  const blackDrawback = stringAt(drawbacks.black, "trace.drawbacks.black");
  for (const [index, ply] of plies.entries()) {
    const expectedDrawback =
      ply.color === "white" ? whiteDrawback : blackDrawback;
    if (ply.activeSecret.drawbackId !== expectedDrawback) {
      throw new TypeError(
        `trace.plies[${String(index)}].activeSecret.drawbackId does not match the post-game reveal.`,
      );
    }
  }
  const result = resultAt(object.result, "trace.result");
  const stoppedAtPlyLimit = booleanAt(
    object.stoppedAtPlyLimit,
    "trace.stoppedAtPlyLimit",
  );
  if (stoppedAtPlyLimit !== (result.kind === "active")) {
    throw new TypeError(
      "trace.stoppedAtPlyLimit must be true exactly when the result is active.",
    );
  }
  if (stoppedAtPlyLimit && plies.length !== plyLimit) {
    throw new TypeError(
      "A trace stopped at its ply limit must contain exactly plyLimit plies.",
    );
  }
  return {
    format: PRIVATE_SIMULATION_TRACE_FORMAT,
    schemaVersion: PRIVATE_SIMULATION_TRACE_SCHEMA_VERSION,
    authorityId: "standard-chess/v1",
    gameIndex,
    gameId: expectedGameId,
    seed,
    plyLimit,
    initialFen,
    finalFen,
    result,
    stoppedAtPlyLimit,
    evaluatorCoverage,
    drawbacks: {
      white: whiteDrawback,
      black: blackDrawback,
    },
    agents: {
      white: agentAt(agents.white, "trace.agents.white"),
      black: agentAt(agents.black, "trace.agents.black"),
    },
    plies,
  };
}

export function parsePrivateSimulationTraceLine(
  line: string,
): PrivateSimulationTraceRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error: unknown) {
    throw new SyntaxError(
      `Private simulation trace line is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parsePrivateSimulationTraceRecord(value);
}
