import {
  deriveSimulationStreamSeed,
  Mulberry32,
} from "@drawbackengine/shared";
import {
  CapturableKingPosition,
} from "@drawbackengine/chess-core";
import { deriveGameSeed } from "./batch.js";
import {
  PLAYER_PRIVATE_RULE_IDS,
  type PlayerPrivateRuleId,
} from "./player-private-catalog.js";
import type {
  PlayerPrivateGameAssignment,
} from "./player-private-parallel-protocol.js";

export const PLAYER_PRIVATE_DATA_SPLITS = [
  "train",
  "validation",
  "test",
] as const;

export type PlayerPrivateDataSplit =
  (typeof PLAYER_PRIVATE_DATA_SPLITS)[number];

export interface PlayerPrivateSplitCounts {
  readonly train: number;
  readonly validation: number;
  readonly test: number;
}

export interface PlayerPrivateAssignmentScheduleOptions {
  readonly splitCounts: PlayerPrivateSplitCounts;
  readonly labelSeed: number;
  readonly gameplaySeed: number;
  readonly parameterSeed: number;
  readonly ruleIds?: readonly PlayerPrivateRuleId[];
  readonly initialFens?: readonly string[];
}

export interface ScheduledPlayerPrivateAssignment {
  readonly globalIndex: number;
  readonly split: PlayerPrivateDataSplit;
  readonly splitIndex: number;
  readonly assignment: PlayerPrivateGameAssignment;
}

const MAX_ASSIGNMENTS = 0x1_0000_0000;
const SCHEDULE_DOMAINS = Object.freeze({
  whiteLabels: 0xa91f_0b21,
  blackLabels: 0x76e3_4cd5,
  whiteParameters: 0x1c69_ae77,
  blackParameters: 0xd432_508b,
  initialFen: 0x8f4b_9d31,
});

/**
 * Creates a lazy, mutation-independent Latin-pair assignment schedule.
 *
 * For R rules, every R games balance each color's marginal labels and every
 * R² games cover each ordered White/Black pair exactly once. Each split resets
 * the Latin cycle while global indices and gameplay seeds remain disjoint.
 */
export function createPlayerPrivateAssignmentSchedule(
  options: PlayerPrivateAssignmentScheduleOptions,
): Iterable<ScheduledPlayerPrivateAssignment> {
  const splitCounts = checkedSplitCounts(options.splitCounts);
  const labelSeed = unsignedSeed(options.labelSeed, "labelSeed");
  const gameplaySeed = unsignedSeed(options.gameplaySeed, "gameplaySeed");
  const parameterSeed = unsignedSeed(
    options.parameterSeed,
    "parameterSeed",
  );
  const ruleIds = checkedRuleIds(
    options.ruleIds ?? PLAYER_PRIVATE_RULE_IDS,
  );
  const initialFens = checkedInitialFens(options.initialFens);
  const whiteRules = shuffledRules(
    ruleIds,
    deriveSimulationStreamSeed(
      labelSeed,
      SCHEDULE_DOMAINS.whiteLabels,
      0,
    ),
  );
  const blackRules = shuffledRules(
    ruleIds,
    deriveSimulationStreamSeed(
      labelSeed,
      SCHEDULE_DOMAINS.blackLabels,
      0,
    ),
  );
  return Object.freeze({
    *[Symbol.iterator](): Iterator<ScheduledPlayerPrivateAssignment> {
      let globalIndex = 0;
      for (const split of PLAYER_PRIVATE_DATA_SPLITS) {
        const count = splitCounts[split];
        for (let splitIndex = 0; splitIndex < count; splitIndex += 1) {
          const slot = splitIndex % ruleIds.length;
          const round =
            Math.floor(splitIndex / ruleIds.length) % ruleIds.length;
          const whiteRuleId = whiteRules[slot];
          const blackRuleId =
            blackRules[(slot + round) % ruleIds.length];
          if (whiteRuleId === undefined || blackRuleId === undefined) {
            throw new Error("Latin assignment schedule lost a rule.");
          }
          yield Object.freeze({
            globalIndex,
            split,
            splitIndex,
            assignment: Object.freeze({
              seed: deriveGameSeed(gameplaySeed, globalIndex),
              parameterSeeds: Object.freeze({
                white: deriveSimulationStreamSeed(
                  parameterSeed,
                  SCHEDULE_DOMAINS.whiteParameters,
                  globalIndex,
                ),
                black: deriveSimulationStreamSeed(
                  parameterSeed,
                  SCHEDULE_DOMAINS.blackParameters,
                  globalIndex,
                ),
              }),
              whiteRuleId,
              blackRuleId,
              ...(initialFens === undefined
                ? {}
                : {
                    initialFen: initialFens[
                      deriveSimulationStreamSeed(
                        gameplaySeed,
                        SCHEDULE_DOMAINS.initialFen,
                        globalIndex,
                      ) % initialFens.length
                    ],
                  }),
            }),
          });
          globalIndex += 1;
        }
      }
    },
  });
}

function checkedInitialFens(
  input: readonly string[] | undefined,
): readonly string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  const copy = [...input];
  if (
    copy.length === 0
    || new Set(copy).size !== copy.length
    || copy.some(
      (fen) =>
        typeof fen !== "string"
        || fen.trim() !== fen
        || fen.length === 0
        || /[\r\n]/u.test(fen),
    )
  ) {
    throw new RangeError(
      "initialFens must be a non-empty unique list of single-line FENs.",
    );
  }
  for (const fen of copy) {
    if (CapturableKingPosition.fromFen(fen).fen !== fen) {
      throw new RangeError("initialFens must contain canonical FENs.");
    }
  }
  return Object.freeze(copy);
}

function checkedSplitCounts(
  input: PlayerPrivateSplitCounts,
): Readonly<PlayerPrivateSplitCounts> {
  let total = 0;
  const values: Record<PlayerPrivateDataSplit, number> = {
    train: 0,
    validation: 0,
    test: 0,
  };
  for (const split of PLAYER_PRIVATE_DATA_SPLITS) {
    const count = input[split];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError(`${split} count must be a non-negative integer.`);
    }
    total += count;
    values[split] = count;
  }
  if (total <= 0 || total > MAX_ASSIGNMENTS) {
    throw new RangeError(
      "Total scheduled games must be from 1 through 4294967296.",
    );
  }
  return Object.freeze(values);
}

function checkedRuleIds(
  input: readonly PlayerPrivateRuleId[],
): readonly PlayerPrivateRuleId[] {
  const copy = [...input];
  if (
    copy.length === 0
    || new Set(copy).size !== copy.length
    || copy.some((id) => !PLAYER_PRIVATE_RULE_IDS.includes(id))
  ) {
    throw new RangeError(
      "ruleIds must be a non-empty unique subset of the audited catalog.",
    );
  }
  return Object.freeze(copy);
}

function shuffledRules(
  ruleIds: readonly PlayerPrivateRuleId[],
  seed: number,
): readonly PlayerPrivateRuleId[] {
  const result = [...ruleIds];
  const rng = new Mulberry32(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = rng.integer(index + 1);
    const current = result[index];
    const replacement = result[other];
    if (current === undefined || replacement === undefined) {
      throw new Error("Rule permutation index is missing.");
    }
    result[index] = replacement;
    result[other] = current;
  }
  return Object.freeze(result);
}

function unsignedSeed(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > 0xffff_ffff
  ) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer.`);
  }
  return value;
}
