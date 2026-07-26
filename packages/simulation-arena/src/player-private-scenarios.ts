import { CapturableKingPosition } from "@drawbackengine/chess-core";
import type { PlayerPrivateRuleId } from "./player-private-catalog.js";
import type {
  PlayerPrivateOpponentHypothesisPolicy,
} from "./player-private-parallel-protocol.js";
import type {
  PlayerPrivateOpponentAggregation,
} from "@drawbackengine/drawback-search";

export interface PlayerPrivateTrainingScenario {
  readonly id: string;
  readonly fen: string;
  readonly purpose: string;
}

export interface PlayerPrivateTrainingProfile {
  readonly id: string;
  readonly policyId: string;
  readonly ruleIds?: readonly PlayerPrivateRuleId[];
  readonly scenarios?: readonly PlayerPrivateTrainingScenario[];
  readonly opponentHypotheses?: PlayerPrivateOpponentHypothesisPolicy;
  readonly opponentAggregation?: PlayerPrivateOpponentAggregation;
}

const KING_CAPTURE_RULE_IDS = Object.freeze([
  "femme-fatale",
  "nurturer",
  "triple-play",
  "you-best-not-miss",
  "irresistible",
] as const satisfies readonly PlayerPrivateRuleId[]);

/**
 * Public starting positions for label-independent hard-negative generation.
 *
 * Each color receives symmetric queen/non-queen king-capture opportunities,
 * an immediately promotable pawn, and a checking sequence that can arm You
 * Best Not Miss. The scheduler chooses a scenario from gameplay randomness,
 * never from the hidden drawback label or parameter seed.
 */
export const KING_CAPTURE_DIAGNOSTIC_SCENARIOS = Object.freeze(
  checkedScenarios([
    {
      id: "white-three-knights",
      fen: "4k3/4Q3/3N1N1N/8/8/8/8/4K3 w - - 0 1",
      purpose:
        "White has queen and knight king captures while owning three knights.",
    },
    {
      id: "black-three-knights",
      fen: "4k3/8/8/8/8/3n1n1n/4q3/4K3 b - - 0 1",
      purpose:
        "Black has queen and knight king captures while owning three knights.",
    },
    {
      id: "white-three-bishops",
      fen: "4k3/4Q3/8/1B1B1B2/8/8/8/4K3 w - - 0 1",
      purpose:
        "White has queen and bishop king captures while owning three bishops.",
    },
    {
      id: "black-three-bishops",
      fen: "4k3/8/8/8/1b1b1b2/8/4q3/4K3 b - - 0 1",
      purpose:
        "Black has queen and bishop king captures while owning three bishops.",
    },
    {
      id: "white-promotion-unlock",
      fen: "4k3/P3Q3/3B4/8/8/8/8/4K3 w - - 0 1",
      purpose:
        "White can promote instead of an initially locked queen king capture.",
    },
    {
      id: "black-promotion-unlock",
      fen: "4k3/8/8/8/8/3b4/p3q3/4K3 b - - 0 1",
      purpose:
        "Black can promote instead of an initially locked queen king capture.",
    },
    {
      id: "white-check-obligation",
      fen: "4k3/4q3/3Q4/8/8/8/8/K3R3 w - - 0 1",
      purpose:
        "White can give check before a next-turn king-capture obligation.",
    },
    {
      id: "black-check-obligation",
      fen: "k3r3/8/8/8/8/3q4/4Q3/4K3 b - - 0 1",
      purpose:
        "Black can give check before a next-turn king-capture obligation.",
    },
  ]),
);

export const STANDARD_PLAYER_PRIVATE_PROFILE: PlayerPrivateTrainingProfile =
  Object.freeze({
    id: "standard",
    policyId: "material-player-private-corpus/v1",
  });

export const KING_CAPTURE_DIAGNOSTIC_PROFILE: PlayerPrivateTrainingProfile =
  Object.freeze({
    id: "king-capture-diagnostics-v1",
    policyId: "material-player-private-king-diagnostics/v1",
    ruleIds: KING_CAPTURE_RULE_IDS,
    scenarios: KING_CAPTURE_DIAGNOSTIC_SCENARIOS,
  });

export const AUDITED_OPPONENT_PROFILE: PlayerPrivateTrainingProfile =
  Object.freeze({
    id: "audited-opponent-v1",
    policyId: "material-player-private-audited-opponent/v1",
    opponentAggregation: "worst-case",
    opponentHypotheses: Object.freeze({
      kind: "audited-uniform",
      version: 1,
    }),
  });

export const PLAYER_PRIVATE_TRAINING_PROFILES = Object.freeze([
  STANDARD_PLAYER_PRIVATE_PROFILE,
  KING_CAPTURE_DIAGNOSTIC_PROFILE,
  AUDITED_OPPONENT_PROFILE,
]);

export function resolvePlayerPrivateTrainingProfile(
  id: string,
): PlayerPrivateTrainingProfile {
  const profile = PLAYER_PRIVATE_TRAINING_PROFILES.find(
    (candidate) => candidate.id === id,
  );
  if (profile === undefined) {
    throw new RangeError(
      `Unknown player-private training profile: ${id}.`,
    );
  }
  return profile;
}

function checkedScenarios(
  input: readonly PlayerPrivateTrainingScenario[],
): readonly PlayerPrivateTrainingScenario[] {
  if (
    input.length === 0
    || new Set(input.map(({ id }) => id)).size !== input.length
    || new Set(input.map(({ fen }) => fen)).size !== input.length
  ) {
    throw new Error("Training scenarios must have unique IDs and FENs.");
  }
  return input.map((scenario) => {
    if (
      scenario.id.trim() !== scenario.id
      || scenario.id.length === 0
      || /[\r\n]/u.test(scenario.id)
      || scenario.purpose.trim() !== scenario.purpose
      || scenario.purpose.length === 0
      || /[\r\n]/u.test(scenario.purpose)
    ) {
      throw new Error("Training scenario metadata is invalid.");
    }
    const canonicalFen = CapturableKingPosition.fromFen(scenario.fen).fen;
    if (canonicalFen !== scenario.fen) {
      throw new Error(
        `Training scenario ${scenario.id} FEN is not canonical.`,
      );
    }
    return Object.freeze({ ...scenario });
  });
}
