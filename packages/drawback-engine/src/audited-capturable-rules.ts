import {
  capturableKingRules,
} from "./rules/capturable-king-rules.js";
import {
  executableRules,
} from "./rules/executable-rules.js";
import type { DrawbackRule } from "./types.js";

/**
 * Historical version-two allowlist for player-private capturable-king
 * simulation.
 *
 * This tuple is a persisted wire identity. Never widen or reorder it.
 * Membership means the rule has authority-specific integration coverage. It
 * does not upgrade the individual rule's verification status.
 */
export const AUDITED_CAPTURABLE_KING_RULE_IDS_V2 = Object.freeze([
  "vegan",
  "true-gentleman",
  "false-prophets",
  "trophy-wife",
  "lame-duck",
  "cess",
  "forward-march",
  "checkers",
  "pacman",
  "oddball",
  "even-keeled",
  "truant",
  "spice-of-life",
  "quit-horsing-around",
  "remorseful",
  "battle-fatigue",
  "eye-for-an-eye",
  "barbarian-rage",
  "conscientious-objectors",
  "horse-tranquilizer",
  "femme-fatale",
  "nurturer",
  "triple-play",
  "you-best-not-miss",
  "irresistible",
] as const);

/**
 * Backward-compatible name used by the version-two simulation and trace
 * packages. It intentionally remains the frozen 25-label tuple.
 */
export const AUDITED_CAPTURABLE_KING_RULE_IDS =
  AUDITED_CAPTURABLE_KING_RULE_IDS_V2;

export type AuditedCapturableKingRuleId =
  (typeof AUDITED_CAPTURABLE_KING_RULE_IDS)[number];

/**
 * Version-three authority compatibility wave.
 *
 * Consumers must opt in explicitly; version-two parsers and simulators keep
 * using {@link AUDITED_CAPTURABLE_KING_RULE_IDS}.
 */
export const AUDITED_CAPTURABLE_KING_RULE_IDS_V3 = Object.freeze([
  ...AUDITED_CAPTURABLE_KING_RULE_IDS_V2,
  "far-sighted",
  "stop-stalling",
  "whites-of-their-eyes",
  "elephants-fear-mice",
  "control-center",
  "indecisive",
  "professional-courtesy",
  "scent-of-blood",
  "champing-at-the-bit",
  "shadow-queen",
  "stay-at-home-mom",
  "snipers",
] as const);

export type AuditedCapturableKingRuleIdV3 =
  (typeof AUDITED_CAPTURABLE_KING_RULE_IDS_V3)[number];

/**
 * Version-four authority compatibility wave.
 *
 * Version two remains the player-private wire identity and version three
 * remains the frozen 37-rule authority compatibility registry. This additive
 * registry certifies five more existing rules without enrolling them in
 * either older vocabulary.
 */
export const AUDITED_CAPTURABLE_KING_RULE_IDS_V4 = Object.freeze([
  ...AUDITED_CAPTURABLE_KING_RULE_IDS_V3,
  "greedy",
  "out-of-breath",
  "queen-bee",
  "alternator",
  "hopscotch",
] as const);

export type AuditedCapturableKingRuleIdV4 =
  (typeof AUDITED_CAPTURABLE_KING_RULE_IDS_V4)[number];

const authorityRules = Object.freeze([
  ...executableRules.filter((rule) =>
    rule.supportedAuthorities?.includes("capturable-king/v1") === true
  ),
  ...capturableKingRules,
]);
const authorityRulesById = new Map(
  authorityRules.map((rule) => [rule.id, rule]),
);

if (
  authorityRules.length !== AUDITED_CAPTURABLE_KING_RULE_IDS_V4.length
  || authorityRulesById.size !== AUDITED_CAPTURABLE_KING_RULE_IDS_V4.length
  || AUDITED_CAPTURABLE_KING_RULE_IDS_V4.some(
    (id) => !authorityRulesById.has(id),
  )
) {
  throw new Error(
    "Audited capturable-king rule catalog is out of sync with authority coverage.",
  );
}

const versionTwoRuleIds = new Set<string>(
  AUDITED_CAPTURABLE_KING_RULE_IDS_V2,
);
const versionThreeRuleIds = new Set<string>(
  AUDITED_CAPTURABLE_KING_RULE_IDS_V3,
);
const versionFourRuleIds = new Set<string>(
  AUDITED_CAPTURABLE_KING_RULE_IDS_V4,
);

export function resolveAuditedCapturableKingRule(
  id: AuditedCapturableKingRuleId,
): DrawbackRule<unknown, unknown> {
  if (!versionTwoRuleIds.has(id)) {
    throw new RangeError(`Unknown audited capturable-king rule: ${id}.`);
  }
  const rule = authorityRulesById.get(id);
  if (rule === undefined) {
    throw new RangeError(`Unknown audited capturable-king rule: ${id}.`);
  }
  return rule;
}

export function resolveAuditedCapturableKingRuleV3(
  id: AuditedCapturableKingRuleIdV3,
): DrawbackRule<unknown, unknown> {
  if (!versionThreeRuleIds.has(id)) {
    throw new RangeError(`Unknown audited capturable-king v3 rule: ${id}.`);
  }
  const rule = authorityRulesById.get(id);
  if (rule === undefined) {
    throw new RangeError(`Unknown audited capturable-king v3 rule: ${id}.`);
  }
  return rule;
}

export function resolveAuditedCapturableKingRuleV4(
  id: AuditedCapturableKingRuleIdV4,
): DrawbackRule<unknown, unknown> {
  if (!versionFourRuleIds.has(id)) {
    throw new RangeError(`Unknown audited capturable-king v4 rule: ${id}.`);
  }
  const rule = authorityRulesById.get(id);
  if (rule === undefined) {
    throw new RangeError(`Unknown audited capturable-king v4 rule: ${id}.`);
  }
  return rule;
}

export function isAuditedCapturableKingRuleId(
  value: string,
): value is AuditedCapturableKingRuleId {
  return versionTwoRuleIds.has(value);
}

export function isAuditedCapturableKingRuleIdV3(
  value: string,
): value is AuditedCapturableKingRuleIdV3 {
  return versionThreeRuleIds.has(value);
}

export function isAuditedCapturableKingRuleIdV4(
  value: string,
): value is AuditedCapturableKingRuleIdV4 {
  return versionFourRuleIds.has(value);
}
