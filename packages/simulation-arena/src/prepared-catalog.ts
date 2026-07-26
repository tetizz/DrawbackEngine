import {
  preparedExecutableRules,
  resolvePreparedExecutableRule,
  type ExternalTurnConstraintProvider,
  type PreparedExecutableDrawbackRule,
} from "@drawbackengine/drawback-engine";
import { Mulberry32 } from "@drawbackengine/shared";
import {
  CATALOG_AGENT_IDS,
  EXECUTABLE_RULE_IDS,
  resolveCatalogAgent,
  type AgentProfile,
  type CatalogAgentId,
} from "./catalog.js";
import {
  asAsyncAgent,
  simulateGameAsync,
} from "./async-simulation.js";
import type { SimulationResult } from "./simulation.js";

/**
 * Complete simulation catalog, including rules whose legal mask must be
 * prepared asynchronously by an external turn-constraint provider.
 */
export const PREPARED_EXECUTABLE_RULE_IDS = Object.freeze([
  ...EXECUTABLE_RULE_IDS,
  "hand-and-gigabrain",
  "ichtyophobe",
] as const);

export type PreparedExecutableRuleId =
  (typeof PREPARED_EXECUTABLE_RULE_IDS)[number];

export interface PreparedCatalogSelectionOptions {
  readonly ruleIds?: readonly PreparedExecutableRuleId[];
  readonly agentIds?: readonly CatalogAgentId[];
  readonly maxPlies?: number;
}

export interface PreparedCatalogGameSpec {
  readonly whiteRuleId: PreparedExecutableRuleId;
  readonly blackRuleId: PreparedExecutableRuleId;
  readonly whiteAgent: AgentProfile;
  readonly blackAgent: AgentProfile;
}

export interface PreparedCatalogGameAssignment {
  readonly seed: number;
  readonly whiteRuleId: PreparedExecutableRuleId;
  readonly blackRuleId: PreparedExecutableRuleId;
  readonly whiteAgentId: CatalogAgentId;
  readonly blackAgentId: CatalogAgentId;
}

const preparedRuleIds = new Set(
  preparedExecutableRules.map((rule) => rule.id),
);

if (
  preparedExecutableRules.length !== PREPARED_EXECUTABLE_RULE_IDS.length ||
  new Set(PREPARED_EXECUTABLE_RULE_IDS).size !==
    PREPARED_EXECUTABLE_RULE_IDS.length ||
  PREPARED_EXECUTABLE_RULE_IDS.some((id) => !preparedRuleIds.has(id)) ||
  preparedExecutableRules.some(
    (rule) => !PREPARED_EXECUTABLE_RULE_IDS.includes(
      rule.id as PreparedExecutableRuleId,
    ),
  )
) {
  throw new Error(
    "Prepared simulation rule IDs are out of sync with the executable catalog.",
  );
}

function choices<T>(
  configured: readonly T[] | undefined,
  defaults: readonly T[],
  label: string,
): readonly T[] {
  const selected = configured ?? defaults;
  if (selected.length === 0) {
    throw new RangeError(`${label} selection catalog cannot be empty.`);
  }
  return selected;
}

function pick<T>(values: readonly T[], rng: Mulberry32): T {
  const selected = values[rng.integer(values.length)];
  if (selected === undefined) {
    throw new Error("Prepared catalog selection invariant failed.");
  }
  return selected;
}

function publicProfile(id: CatalogAgentId): AgentProfile {
  const agent = resolveCatalogAgent(id);
  if (agent.style === undefined || agent.strength === undefined) {
    throw new Error(`Catalog agent ${id} is missing profile metadata.`);
  }
  if (
    agent.style !== "random" &&
    agent.style !== "material" &&
    agent.style !== "human-like"
  ) {
    throw new Error(`Catalog agent ${id} has an unknown style.`);
  }
  return {
    id,
    style: agent.style,
    strength: agent.strength,
  };
}

/**
 * Uses the same seeded draw order as the synchronous catalog: White rule,
 * Black rule, White agent, then Black agent.
 */
export function derivePreparedCatalogGameSpec(
  gameSeed: number,
  options: PreparedCatalogSelectionOptions = {},
): PreparedCatalogGameSpec {
  const rng = new Mulberry32(gameSeed ^ 0xc0de_cafe);
  const rules = choices(
    options.ruleIds,
    PREPARED_EXECUTABLE_RULE_IDS,
    "rule",
  );
  const agents = choices(options.agentIds, CATALOG_AGENT_IDS, "agent");
  return {
    whiteRuleId: pick(rules, rng),
    blackRuleId: pick(rules, rng),
    whiteAgent: publicProfile(pick(agents, rng)),
    blackAgent: publicProfile(pick(agents, rng)),
  };
}

export function resolvePreparedCatalogRule(
  id: PreparedExecutableRuleId,
): PreparedExecutableDrawbackRule {
  return resolvePreparedExecutableRule(id);
}

/**
 * Simulates from the complete rule catalog. The provider is borrowed: the
 * caller remains responsible for disposing it after all games finish.
 */
export async function simulatePreparedCatalogGame(
  gameSeed: number,
  turnConstraintProvider: ExternalTurnConstraintProvider,
  options: PreparedCatalogSelectionOptions = {},
): Promise<SimulationResult> {
  const spec = derivePreparedCatalogGameSpec(gameSeed, options);
  return simulatePreparedCatalogAssignedGame(
    {
      seed: gameSeed,
      whiteRuleId: spec.whiteRuleId,
      blackRuleId: spec.blackRuleId,
      whiteAgentId: spec.whiteAgent.id,
      blackAgentId: spec.blackAgent.id,
    },
    turnConstraintProvider,
    options.maxPlies === undefined ? {} : { maxPlies: options.maxPlies },
  );
}

/**
 * Simulates one immutable scheduler assignment without reselecting hidden
 * labels or agent identities from the game seed.
 */
export async function simulatePreparedCatalogAssignedGame(
  assignment: PreparedCatalogGameAssignment,
  turnConstraintProvider: ExternalTurnConstraintProvider,
  options: Pick<PreparedCatalogSelectionOptions, "maxPlies"> = {},
): Promise<SimulationResult> {
  return simulateGameAsync({
    seed: assignment.seed,
    rules: {
      white: resolvePreparedCatalogRule(assignment.whiteRuleId),
      black: resolvePreparedCatalogRule(assignment.blackRuleId),
    },
    whiteAgent: asAsyncAgent(resolveCatalogAgent(assignment.whiteAgentId)),
    blackAgent: asAsyncAgent(resolveCatalogAgent(assignment.blackAgentId)),
    turnConstraintProvider,
    ...(options.maxPlies === undefined
      ? {}
      : { maxPlies: options.maxPlies }),
  });
}
