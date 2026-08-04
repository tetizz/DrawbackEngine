import { createHash } from "node:crypto";
import type {
  SessionResult,
  SessionSecretSnapshot,
} from "@drawbackengine/chess-core";
import {
  drawbackMaterialEvaluator,
  type DrawbackLeafEvaluator,
  type IterativePlayerPrivateSearchLimits,
  type PlayerPrivateOpponentAggregation,
  type RootTemperatureSelectionOptions,
} from "@drawbackengine/drawback-search";
import type { PlayerColor } from "@drawbackengine/shared";
import {
  createPlayerPrivateSearchAgent,
  type PlayerPrivateAgentSearchPolicy,
  type PlayerPrivateSimulationAgent,
} from "./player-private-agent.js";
import {
  assertPlayerPrivateGameAssignment,
  type PlayerPrivateGameAssignment,
} from "./player-private-parallel-protocol.js";
import { resolvePlayerPrivateRule } from "./player-private-catalog.js";
import {
  auditedUniformOpponentHypotheses,
  simulatePlayerPrivateGame,
  type PlayerPrivateSimulationResult,
  type PublicOpponentHypothesisProvider,
} from "./player-private-simulation.js";
import {
  DEFAULT_STRENGTH_CONFIDENCE_LEVEL,
  summarizePairedStrengthScores,
  type CandidateGameScore,
  type PairedStrengthScoreSummary,
  type StrengthScoreBounds,
} from "./player-private-strength-statistics.js";

export const PLAYER_PRIVATE_STRENGTH_REPORT_FORMAT =
  "drawbackengine-player-private-strength/v1";

export type PlayerPrivateStrengthEvaluatorKind =
  | "material"
  | "fairy-stockfish";

export interface PlayerPrivateStrengthParticipant {
  readonly id: string;
  readonly policyId?: string;
  readonly evaluatorKind: PlayerPrivateStrengthEvaluatorKind;
  readonly evaluator: DrawbackLeafEvaluator;
  readonly limits: IterativePlayerPrivateSearchLimits;
  readonly opponentAggregation?: PlayerPrivateOpponentAggregation;
  readonly temperature: RootTemperatureSelectionOptions;
}

export interface PlayerPrivateStrengthHarnessOptions {
  readonly candidate: PlayerPrivateStrengthParticipant;
  readonly baseline: PlayerPrivateStrengthParticipant;
  readonly assignments: readonly PlayerPrivateGameAssignment[];
  readonly opponentHypotheses?: PublicOpponentHypothesisProvider;
  readonly maxPlies?: number;
  readonly confidenceLevel?: number;
  /** Cancels assignment validation and work between game legs. */
  readonly signal?: AbortSignal;
}

export interface PlayerPrivateStrengthParticipantSnapshot {
  readonly role: "candidate" | "baseline";
  readonly id: string;
  readonly evaluator: {
    readonly kind: PlayerPrivateStrengthEvaluatorKind;
    readonly id: string;
  };
  readonly searchPolicy: PlayerPrivateAgentSearchPolicy;
}

export interface PlayerPrivateStrengthLegResult {
  readonly candidateColor: PlayerColor;
  /** Public terminal classification; drawback IDs and loss reasons stay secret. */
  readonly outcome:
    | "ply-limit"
    | Exclude<SessionResult["kind"], "active">;
  readonly winner: PlayerColor | null;
  readonly candidateScore: CandidateGameScore;
  readonly plies: number;
  readonly stoppedAtPlyLimit: boolean;
  readonly finalFen: string;
  readonly moveTraceSha256: string;
}

export interface PlayerPrivateStrengthPairResult {
  readonly pairIndex: number;
  readonly executionOrder: readonly [PlayerColor, PlayerColor];
  readonly candidateWhite: PlayerPrivateStrengthLegResult;
  readonly candidateBlack: PlayerPrivateStrengthLegResult;
  readonly pairedCandidateScore: number | null;
  readonly pairedScoreDelta: number | null;
  readonly pairedScoreDeltaBounds: StrengthScoreBounds;
}

export interface PlayerPrivateStrengthReport {
  readonly format: typeof PLAYER_PRIVATE_STRENGTH_REPORT_FORMAT;
  readonly knowledgeMode: "player-private";
  readonly metric: "paired-game-score";
  readonly pairing:
    "same-hidden-assignment-and-seeds-with-candidate-color-swap";
  readonly authorityId: "capturable-king/v1";
  readonly hypothesisPolicyId: string;
  readonly maxPlies: number;
  readonly participants: {
    readonly candidate: PlayerPrivateStrengthParticipantSnapshot;
    readonly baseline: PlayerPrivateStrengthParticipantSnapshot;
  };
  readonly pairs: readonly PlayerPrivateStrengthPairResult[];
  readonly summary: PairedStrengthScoreSummary;
}

const DEFAULT_MAX_PLIES = 300;
const FAIRY_EVALUATOR_ID = /^node-uci-leaf\/v1\/[0-9a-f]{64}$/u;

/**
 * Runs serial, color-swapped games through the player-private coordinator.
 *
 * Agents receive only their own exact rule capability, the public trace, and
 * public opponent hypotheses. The post-game report authenticates that both
 * legs used the same generated secret assignment without exposing that secret.
 */
export async function runPlayerPrivateStrengthHarness(
  options: PlayerPrivateStrengthHarnessOptions,
): Promise<PlayerPrivateStrengthReport> {
  options.signal?.throwIfAborted();
  const maxPlies = options.maxPlies ?? DEFAULT_MAX_PLIES;
  if (!Number.isSafeInteger(maxPlies) || maxPlies <= 0) {
    throw new RangeError("maxPlies must be a positive safe integer.");
  }
  if (options.assignments.length === 0) {
    throw new RangeError("Strength harness assignments must not be empty.");
  }
  const assignments = checkedAssignments(options.assignments, options.signal);
  const candidate = createParticipantAgent("candidate", options.candidate);
  const baseline = createParticipantAgent("baseline", options.baseline);
  if (candidate.agent.id === baseline.agent.id) {
    throw new RangeError("Candidate and baseline IDs must be different.");
  }
  const opponentHypotheses =
    options.opponentHypotheses ?? auditedUniformOpponentHypotheses;
  validateSingleLineId(opponentHypotheses.id, "Hypothesis policy ID");
  const pairs: PlayerPrivateStrengthPairResult[] = [];

  for (const [pairIndex, assignment] of assignments.entries()) {
    options.signal?.throwIfAborted();
    const executionOrder = Object.freeze(
      pairIndex % 2 === 0
        ? ["white", "black"] as const
        : ["black", "white"] as const,
    );
    const legs = new Map<PlayerColor, PlayerPrivateSimulationResult>();
    for (const candidateColor of executionOrder) {
      options.signal?.throwIfAborted();
      legs.set(
        candidateColor,
        await playLeg(
          assignment,
          candidateColor,
          candidate.agent,
          baseline.agent,
          opponentHypotheses,
          maxPlies,
        ),
      );
      options.signal?.throwIfAborted();
    }
    const whiteGame = requiredLeg(legs, "white");
    const blackGame = requiredLeg(legs, "black");
    assertMatchingInitialSecrets(
      whiteGame.drawbackSecrets.initial,
      blackGame.drawbackSecrets.initial,
    );
    if (whiteGame.initialFen !== blackGame.initialFen) {
      throw new Error("Color-swapped pair did not use the same initial position.");
    }
    const candidateWhite = legResult(whiteGame, "white");
    const candidateBlack = legResult(blackGame, "black");
    const pairedBounds = pairScoreDeltaBounds(
      candidateWhite.candidateScore,
      candidateBlack.candidateScore,
    );
    const pairedCandidateScore = completePairScore(
      candidateWhite.candidateScore,
      candidateBlack.candidateScore,
    );
    pairs.push(Object.freeze({
      pairIndex,
      executionOrder,
      candidateWhite,
      candidateBlack,
      pairedCandidateScore,
      pairedScoreDelta:
        pairedCandidateScore === null ? null : pairedCandidateScore - 0.5,
      pairedScoreDeltaBounds: pairedBounds,
    }));
  }

  const summary = summarizePairedStrengthScores(
    pairs.map((pair) => Object.freeze({
      candidateWhite: pair.candidateWhite.candidateScore,
      candidateBlack: pair.candidateBlack.candidateScore,
    })),
    options.confidenceLevel ?? DEFAULT_STRENGTH_CONFIDENCE_LEVEL,
  );
  return freezeRecursively({
    format: PLAYER_PRIVATE_STRENGTH_REPORT_FORMAT,
    knowledgeMode: "player-private" as const,
    metric: "paired-game-score" as const,
    pairing:
      "same-hidden-assignment-and-seeds-with-candidate-color-swap" as const,
    authorityId: "capturable-king/v1" as const,
    hypothesisPolicyId: opponentHypotheses.id,
    maxPlies,
    participants: {
      candidate: candidate.snapshot,
      baseline: baseline.snapshot,
    },
    pairs,
    summary,
  });
}

function createParticipantAgent(
  role: PlayerPrivateStrengthParticipantSnapshot["role"],
  participant: PlayerPrivateStrengthParticipant,
): {
  readonly agent: PlayerPrivateSimulationAgent;
  readonly snapshot: PlayerPrivateStrengthParticipantSnapshot;
} {
  validateSingleLineId(participant.id, `${role} ID`);
  validateEvaluator(participant);
  const agent = createPlayerPrivateSearchAgent({
    id: participant.id,
    ...(participant.policyId === undefined
      ? {}
      : { policyId: participant.policyId }),
    evaluator: participant.evaluator,
    limits: participant.limits,
    ...(participant.opponentAggregation === undefined
      ? {}
      : { opponentAggregation: participant.opponentAggregation }),
    temperature: participant.temperature,
  });
  if (agent.searchPolicy === undefined) {
    throw new Error("Strength participant has no player-private search policy.");
  }
  return Object.freeze({
    agent,
    snapshot: Object.freeze({
      role,
      id: agent.id,
      evaluator: Object.freeze({
        kind: participant.evaluatorKind,
        id: participant.evaluator.id,
      }),
      searchPolicy: agent.searchPolicy,
    }),
  });
}

async function playLeg(
  assignment: PlayerPrivateGameAssignment,
  candidateColor: PlayerColor,
  candidate: PlayerPrivateSimulationAgent,
  baseline: PlayerPrivateSimulationAgent,
  opponentHypotheses: PublicOpponentHypothesisProvider,
  maxPlies: number,
): Promise<PlayerPrivateSimulationResult> {
  return simulatePlayerPrivateGame({
    seed: assignment.seed,
    parameterSeeds: assignment.parameterSeeds,
    rules: {
      white: resolvePlayerPrivateRule(assignment.whiteRuleId),
      black: resolvePlayerPrivateRule(assignment.blackRuleId),
    },
    whiteAgent: candidateColor === "white" ? candidate : baseline,
    blackAgent: candidateColor === "black" ? candidate : baseline,
    opponentHypotheses,
    maxPlies,
    ...(assignment.initialFen === undefined
      ? {}
      : { fen: assignment.initialFen }),
  });
}

function legResult(
  game: PlayerPrivateSimulationResult,
  candidateColor: PlayerColor,
): PlayerPrivateStrengthLegResult {
  const winner = resultWinner(game.result);
  if (game.result.kind === "active" && !game.stoppedAtPlyLimit) {
    throw new Error("Active strength game did not stop at its ply limit.");
  }
  if (game.result.kind !== "active" && game.stoppedAtPlyLimit) {
    throw new Error("Completed strength game is incorrectly marked ply-limited.");
  }
  return Object.freeze({
    candidateColor,
    outcome:
      game.result.kind === "active" ? "ply-limit" : game.result.kind,
    winner,
    candidateScore:
      game.result.kind === "active"
        ? null
        : game.result.kind === "draw"
          ? 0.5
          : winner === candidateColor ? 1 : 0,
    plies: game.plies.length,
    stoppedAtPlyLimit: game.stoppedAtPlyLimit,
    finalFen: game.finalFen,
    moveTraceSha256: digestCanonical(
      {
        initialFen: game.initialFen,
        moves: game.plies.map(({ observation }) => moveId(observation.move)),
      },
    ),
  });
}

function resultWinner(result: SessionResult): PlayerColor | null {
  switch (result.kind) {
    case "active":
    case "draw":
      return null;
    case "drawback-loss":
      return opposite(result.loss.color);
    case "king-capture":
    case "no-legal-moves":
    case "checkmate":
      return result.winner;
  }
}

function checkedAssignments(
  input: readonly PlayerPrivateGameAssignment[],
  signal?: AbortSignal,
): readonly PlayerPrivateGameAssignment[] {
  const seeds = new Set<number>();
  return Object.freeze(input.map((assignment) => {
    signal?.throwIfAborted();
    assertPlayerPrivateGameAssignment(assignment);
    if (seeds.has(assignment.seed)) {
      throw new RangeError("Strength assignment seeds must be unique.");
    }
    seeds.add(assignment.seed);
    return freezeRecursively(structuredClone(assignment));
  }));
}

function validateEvaluator(participant: PlayerPrivateStrengthParticipant): void {
  const evaluatorKind: unknown = participant.evaluatorKind;
  if (
    evaluatorKind !== "material"
    && evaluatorKind !== "fairy-stockfish"
  ) {
    throw new RangeError(
      "Strength evaluator kind must be material or fairy-stockfish.",
    );
  }
  validateSingleLineId(participant.evaluator.id, "Evaluator ID");
  if (
    participant.evaluatorKind === "material"
    && participant.evaluator.id !== drawbackMaterialEvaluator.id
  ) {
    throw new RangeError(
      "Material strength participants must use drawback-material/v1.",
    );
  }
  if (
    participant.evaluatorKind === "fairy-stockfish"
    && !FAIRY_EVALUATOR_ID.test(participant.evaluator.id)
  ) {
    throw new RangeError(
      "Fairy-Stockfish strength participants require a pinned node-uci-leaf/v1 evaluator ID.",
    );
  }
}

function validateSingleLineId(value: string, label: string): void {
  if (
    value.length === 0
    || value.trim() !== value
    || /[\r\n\0]/u.test(value)
  ) {
    throw new RangeError(`${label} must be non-empty, trimmed, and single-line.`);
  }
}

function assertMatchingInitialSecrets(
  whiteLeg: SessionSecretSnapshot<unknown, unknown, unknown, unknown>,
  blackLeg: SessionSecretSnapshot<unknown, unknown, unknown, unknown>,
): void {
  const whiteCanonical = canonicalJson(whiteLeg);
  const blackCanonical = canonicalJson(blackLeg);
  if (whiteCanonical !== blackCanonical) {
    throw new Error("Color-swapped pair generated different hidden assignments.");
  }
}

function requiredLeg(
  legs: ReadonlyMap<PlayerColor, PlayerPrivateSimulationResult>,
  color: PlayerColor,
): PlayerPrivateSimulationResult {
  const leg = legs.get(color);
  if (leg === undefined) {
    throw new Error(`Strength pair is missing its candidate-${color} leg.`);
  }
  return leg;
}

function completePairScore(
  white: CandidateGameScore,
  black: CandidateGameScore,
): number | null {
  return white === null || black === null ? null : (white + black) / 2;
}

function pairScoreDeltaBounds(
  white: CandidateGameScore,
  black: CandidateGameScore,
): StrengthScoreBounds {
  return Object.freeze({
    lower: ((white ?? 0) + (black ?? 0)) / 2 - 0.5,
    upper: ((white ?? 1) + (black ?? 1)) / 2 - 0.5,
  });
}

function digestCanonical(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical strength data contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  throw new TypeError("Canonical strength data contains an unsupported value.");
}

function moveId(
  move: {
    readonly from: string;
    readonly to: string;
    readonly promotion?: string;
  },
): string {
  return `${move.from}${move.to}${move.promotion?.[0] ?? ""}`;
}

function opposite(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function freezeRecursively<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const child of Object.values(value)) {
    freezeRecursively(child);
  }
  return Object.freeze(value);
}
