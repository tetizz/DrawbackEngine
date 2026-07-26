import type {
  PublicPositionAuthoritySnapshot,
} from "@drawbackengine/chess-core";
import type { ChessMove } from "@drawbackengine/drawback-engine";
import {
  searchDiagnosticMovesAsync,
  type ProbeHypothesis,
} from "@drawbackengine/probe-search";
import type { PlayerColor } from "@drawbackengine/shared";
import {
  currentStandardTerminal,
  diagnosticMoveId,
  diagnosticReplyKey,
  diagnosticScenarioKey,
  diagnosticTerminalScore,
  immutableDiagnosticMove,
  immutableDiagnosticMoves,
  prepareDiagnosticCandidate,
  publicPositionView,
  requiredPreparedCandidate,
  requiredPreparedScenario,
  throwIfDiagnosticAborted,
  validateDiagnosticRequest,
  type PreparedDiagnosticCandidate,
  type PreparedDiagnosticScenario,
  type ValidatedDiagnosticRequest,
} from "./diagnostic-authority.js";
import {
  DiagnosticEvaluatorFailureError,
  type DiagnosticHypothesisEngineAssessment,
  type DiagnosticRootMoveEngineAssessment,
  type DiagnosticUnsupportedAuthorityFact,
  type PlayerPrivateDiagnosticAssessment,
  type PlayerPrivateDiagnosticCoverage,
  type PlayerPrivateDiagnosticInput,
  type UnsupportedPlayerPrivateDiagnosticAssessment,
} from "./diagnostic-assessment-types.js";
import type { PublicDrawbackHypothesis } from "./player-private-capability.js";
import {
  UnsupportedDrawbackLeafPositionError,
  type LeafPosition,
} from "./types.js";

interface EvaluationProgress {
  evaluatorCalls: number;
  assessedCandidateMoveCount: number;
}

class UnsupportedEvaluationError extends Error {
  public readonly fact: DiagnosticUnsupportedAuthorityFact;

  public constructor(fact: DiagnosticUnsupportedAuthorityFact) {
    super("The diagnostic leaf evaluator cannot represent an exact scenario.");
    this.name = "UnsupportedEvaluationError";
    this.fact = fact;
  }
}

interface ProbeState {
  readonly hypothesisId: string;
}

/**
 * Builds exact one-reply diagnostic recommendations from player-private
 * capabilities and public hypotheses.
 *
 * The evaluator sees only public authority snapshots and exact legal root
 * masks. The API cannot accept an omniscient game session or the opponent's
 * authoritative secret state.
 */
export async function assessPlayerPrivateDiagnosticMoves(
  input: PlayerPrivateDiagnosticInput,
): Promise<PlayerPrivateDiagnosticAssessment> {
  throwIfDiagnosticAborted(input.signal);
  const request = validateDiagnosticRequest(input);
  const progress: EvaluationProgress = {
    evaluatorCalls: 0,
    assessedCandidateMoveCount: 0,
  };
  const inputUnsupportedFacts = input.unsupportedOpponentAuthorities.map(
    (fact): DiagnosticUnsupportedAuthorityFact =>
      Object.freeze({
        component: "opponent-hypothesis",
        authorityId: fact.authorityId,
        reason: fact.reason,
        hypothesisId: fact.hypothesisId,
        drawbackId: fact.drawbackId,
        probability:
          fact.probability
          / (request.supportedMass + request.unsupportedMass),
      }),
  );
  const missingRepetition =
    request.position.authorityId === "standard-chess/v1"
    && input.standardRepetitionAdjudicator === undefined;
  const staticUnsupportedFacts: readonly DiagnosticUnsupportedAuthorityFact[] =
    Object.freeze([
      ...inputUnsupportedFacts,
      ...(missingRepetition
        ? [
            Object.freeze({
              component: "standard-repetition-adjudicator" as const,
              authorityId: request.position.authorityId,
              reason:
                "standard-chess/v1 FEN does not authenticate threefold repetition state.",
            }),
          ]
        : []),
    ]);
  if (staticUnsupportedFacts.length > 0) {
    return unsupportedResult(
      input,
      request,
      progress,
      missingRepetition
        ? "missing-standard-repetition-provenance"
        : "unsupported-opponent-authority",
      false,
      staticUnsupportedFacts,
    );
  }
  if (currentStandardTerminal(input, request) !== null) {
    throw new Error("Cannot assess a completed standard-chess position.");
  }

  const prepared = request.candidates.map((move) =>
    prepareDiagnosticCandidate(input, request, move)
  );
  const scenarios = indexScenarios(prepared);
  const probes: readonly ProbeHypothesis<ProbeState>[] =
    request.normalizedOpponent.map((hypothesis) =>
      Object.freeze({
        drawbackId: hypothesis.hypothesisId,
        probability: hypothesis.probability,
        eliminated: false,
        state: Object.freeze({
          hypothesisId: hypothesis.hypothesisId,
        }),
      })
    );
  const assessments = new Map<string, DiagnosticRootMoveEngineAssessment>();

  try {
    const recommendations = await searchDiagnosticMovesAsync({
      moves: request.candidates,
      hypotheses: probes,
      permittedReplies: (move, hypothesis) =>
        requiredPreparedScenario(
          scenarios,
          move,
          hypothesis.drawbackId,
        ).outcomes,
      replyKey: diagnosticReplyKey,
      assessChess: async (move) => {
        throwIfDiagnosticAborted(input.signal);
        const candidate = requiredPreparedCandidate(prepared, move);
        const assessment = await assessCandidate(
          input,
          request.rootColor,
          candidate,
          progress,
        );
        assessments.set(diagnosticMoveId(move), assessment);
        progress.assessedCandidateMoveCount += 1;
        return assessment;
      },
      ...(input.weights === undefined ? {} : { weights: input.weights }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const moveAssessments = request.candidates.map((move) => {
      const assessment = assessments.get(diagnosticMoveId(move));
      if (assessment === undefined) {
        throw new Error(
          `Diagnostic assessment omitted candidate ${diagnosticMoveId(move)}.`,
        );
      }
      return assessment;
    });
    return Object.freeze({
      status: "complete",
      knowledgeMode: "player-private",
      authorityId: request.position.authorityId,
      evaluatorId: input.evaluator.id,
      coverage: coverage(
        input,
        request,
        progress,
        true,
        true,
        [],
      ),
      recommendations,
      moveAssessments: Object.freeze(moveAssessments),
    });
  } catch (error: unknown) {
    if (error instanceof UnsupportedEvaluationError) {
      return unsupportedResult(
        input,
        request,
        progress,
        "unsupported-leaf-evaluation",
        true,
        [error.fact],
      );
    }
    throw error;
  }
}

function indexScenarios(
  candidates: readonly PreparedDiagnosticCandidate[],
): ReadonlyMap<string, PreparedDiagnosticScenario> {
  const scenarios = new Map<string, PreparedDiagnosticScenario>();
  for (const candidate of candidates) {
    for (const scenario of candidate.scenarios) {
      scenarios.set(
        diagnosticScenarioKey(
          candidate.move,
          scenario.hypothesis.hypothesisId,
        ),
        scenario,
      );
    }
  }
  return scenarios;
}

async function assessCandidate(
  input: PlayerPrivateDiagnosticInput,
  rootColor: PlayerColor,
  candidate: PreparedDiagnosticCandidate,
  progress: EvaluationProgress,
): Promise<DiagnosticRootMoveEngineAssessment> {
  const engineMasks = new Map<string, Promise<number>>();
  const hypothesisAssessments: DiagnosticHypothesisEngineAssessment[] = [];
  for (const scenario of candidate.scenarios) {
    throwIfDiagnosticAborted(input.signal);
    const explicitTerminalScores = scenario.outcomes.flatMap((outcome) =>
      outcome.kind === "terminal"
        ? [
            diagnosticTerminalScore(
              outcome.terminal,
              rootColor,
              outcome.reply === undefined ? 1 : 2,
            ),
          ]
        : []
    );
    const nonTerminalReplies = scenario.outcomes.flatMap((outcome) =>
      outcome.kind === "move" ? [outcome.move] : []
    );
    let engineScore: number | null = null;
    if (nonTerminalReplies.length > 0) {
      const maskKey = nonTerminalReplies
        .map(diagnosticMoveId)
        .sort()
        .join(",");
      let evaluation = engineMasks.get(maskKey);
      if (evaluation === undefined) {
        evaluation = evaluateExactReplyMask(
          input,
          candidate,
          scenario.hypothesis,
          nonTerminalReplies,
          progress,
        );
        engineMasks.set(maskKey, evaluation);
      }
      engineScore = await evaluation;
    }
    const scores = [
      ...explicitTerminalScores,
      ...(engineScore === null ? [] : [engineScore]),
    ];
    const score = Math.min(...scores);
    if (!Number.isFinite(score)) {
      throw new Error(
        `Diagnostic scenario ${scenario.hypothesis.hypothesisId} has no finite outcome.`,
      );
    }
    hypothesisAssessments.push(Object.freeze({
      hypothesisId: scenario.hypothesis.hypothesisId,
      probability: scenario.hypothesis.probability,
      permittedReplyCount: scenario.outcomes.filter(
        (outcome) => outcome.kind === "move" || outcome.reply !== undefined,
      ).length,
      score,
      source:
        engineScore === null
          ? "terminal"
          : explicitTerminalScores.length === 0
            ? "engine"
            : "engine-and-terminal",
    }));
  }
  const chessQuality = hypothesisAssessments.reduce(
    (sum, assessment) =>
      sum + assessment.probability * assessment.score,
    0,
  );
  const worstCase = Math.min(
    ...hypothesisAssessments.map(({ score }) => score),
  );
  const risk = hypothesisAssessments.reduce(
    (sum, assessment) =>
      sum
      + assessment.probability
        * Math.max(0, chessQuality - assessment.score),
    0,
  );
  return Object.freeze({
    move: immutableDiagnosticMove(candidate.move),
    chessQuality,
    worstCase,
    risk,
    hypotheses: Object.freeze(hypothesisAssessments),
  });
}

async function evaluateExactReplyMask(
  input: PlayerPrivateDiagnosticInput,
  candidate: PreparedDiagnosticCandidate,
  hypothesis: PublicDrawbackHypothesis,
  legalMoves: readonly ChessMove[],
  progress: EvaluationProgress,
): Promise<number> {
  throwIfDiagnosticAborted(input.signal);
  progress.evaluatorCalls += 1;
  const leaf = leafPosition(
    candidate.positionAfterMove,
    candidate.historyAfterMove,
    legalMoves,
  );
  try {
    const sideToMoveScore = await abortable(
      input.evaluator.evaluate(leaf, input.signal),
      input.signal,
    );
    if (!Number.isFinite(sideToMoveScore)) {
      throw new RangeError(
        `${input.evaluator.id} returned a non-finite diagnostic score.`,
      );
    }
    return sideToMoveScore === 0 ? 0 : -sideToMoveScore;
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof UnsupportedDrawbackLeafPositionError) {
      throw new UnsupportedEvaluationError(
        Object.freeze({
          component: "leaf-evaluator",
          authorityId: candidate.positionAfterMove.authorityId,
          reason: error.message,
          hypothesisId: hypothesis.hypothesisId,
          candidateMoveId: diagnosticMoveId(candidate.move),
          evaluatorId: input.evaluator.id,
          probability: hypothesis.probability,
        }),
      );
    }
    throw new DiagnosticEvaluatorFailureError(
      input.evaluator.id,
      diagnosticMoveId(candidate.move),
      hypothesis.hypothesisId,
      error,
    );
  }
}

function leafPosition(
  position: PublicPositionAuthoritySnapshot,
  history: readonly ChessMove[],
  legalMoves: readonly ChessMove[],
): LeafPosition {
  return Object.freeze({
    authorityId: position.authorityId,
    fen: position.fen,
    turn: publicPositionView(position, history).turn,
    legalMoves: immutableDiagnosticMoves(legalMoves),
    history: immutableDiagnosticMoves(history),
    orthodoxCompatible:
      position.authorityId === "standard-chess/v1"
      || position.orthodoxCompatible,
    kingPassantActive:
      position.authorityId === "capturable-king/v1"
      && position.kingPassant !== null,
  });
}

function coverage(
  input: PlayerPrivateDiagnosticInput,
  request: ValidatedDiagnosticRequest,
  progress: EvaluationProgress,
  exactReplyCoverage: boolean,
  exactAssessmentCoverage: boolean,
  unsupportedAuthorityFacts:
    readonly DiagnosticUnsupportedAuthorityFact[],
): PlayerPrivateDiagnosticCoverage {
  const totalMass = request.supportedMass + request.unsupportedMass;
  return Object.freeze({
    authorityId: request.position.authorityId,
    evaluatorId: input.evaluator.id,
    standardRepetitionAdjudicatorId:
      request.position.authorityId === "standard-chess/v1"
        ? input.standardRepetitionAdjudicator?.id ?? null
        : null,
    candidateMoveCount: request.candidates.length,
    assessedCandidateMoveCount: progress.assessedCandidateMoveCount,
    requestedHypothesisCount:
      input.opponent.length + input.unsupportedOpponentAuthorities.length,
    supportedHypothesisCount: input.opponent.length,
    unsupportedHypothesisCount:
      input.unsupportedOpponentAuthorities.length,
    supportedHypothesisProbabilityMass: request.supportedMass / totalMass,
    unsupportedHypothesisProbabilityMass: request.unsupportedMass / totalMass,
    exactReplyCoverage,
    exactAssessmentCoverage,
    evaluatorCalls: progress.evaluatorCalls,
    unsupportedAuthorityFacts: Object.freeze([
      ...unsupportedAuthorityFacts,
    ]),
  });
}

function unsupportedResult(
  input: PlayerPrivateDiagnosticInput,
  request: ValidatedDiagnosticRequest,
  progress: EvaluationProgress,
  reason: UnsupportedPlayerPrivateDiagnosticAssessment["reason"],
  exactReplyCoverage: boolean,
  facts: readonly DiagnosticUnsupportedAuthorityFact[],
): UnsupportedPlayerPrivateDiagnosticAssessment {
  return Object.freeze({
    status: "unsupported",
    knowledgeMode: "player-private",
    authorityId: request.position.authorityId,
    evaluatorId: input.evaluator.id,
    reason,
    coverage: coverage(
      input,
      request,
      progress,
      exactReplyCoverage,
      false,
      facts,
    ),
  });
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return operation;
  }
  throwIfDiagnosticAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(
        new DOMException(
          "Player-private diagnostic assessment was aborted.",
          "AbortError",
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(asError(error));
      },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("Evaluator rejected with a non-error value.", {
        cause: value,
      });
}
