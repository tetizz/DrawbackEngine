import {
  capturableKingRules,
} from "./rules/capturable-king-rules.js";
import {
  executableRules,
} from "./rules/executable-rules.js";
import type { DrawbackRule } from "./types.js";

/**
 * Version-two rule allowlist for player-private capturable-king simulation.
 *
 * Membership means the rule has authority-specific integration coverage. It
 * does not upgrade the individual rule's verification status.
 */
export const AUDITED_CAPTURABLE_KING_RULE_IDS = [
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
] as const;

export type AuditedCapturableKingRuleId =
  (typeof AUDITED_CAPTURABLE_KING_RULE_IDS)[number];

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
  authorityRules.length !== AUDITED_CAPTURABLE_KING_RULE_IDS.length
  || authorityRulesById.size !== AUDITED_CAPTURABLE_KING_RULE_IDS.length
  || AUDITED_CAPTURABLE_KING_RULE_IDS.some(
    (id) => !authorityRulesById.has(id),
  )
) {
  throw new Error(
    "Audited capturable-king rule catalog is out of sync with authority coverage.",
  );
}

export function resolveAuditedCapturableKingRule(
  id: AuditedCapturableKingRuleId,
): DrawbackRule<unknown, unknown> {
  const rule = authorityRulesById.get(id);
  if (rule === undefined) {
    throw new RangeError(`Unknown audited capturable-king rule: ${id}.`);
  }
  return rule;
}

export function isAuditedCapturableKingRuleId(
  value: string,
): value is AuditedCapturableKingRuleId {
  return authorityRulesById.has(value);
}
