import {
  capturableKingRules,
  executableRules,
  type DrawbackRule,
} from "@drawbackengine/drawback-engine";

export const PLAYER_PRIVATE_RULE_IDS = [
  "vegan",
  "lame-duck",
  "checkers",
  "truant",
  "spice-of-life",
  "femme-fatale",
  "nurturer",
  "triple-play",
  "you-best-not-miss",
  "irresistible",
] as const;

export type PlayerPrivateRuleId =
  (typeof PLAYER_PRIVATE_RULE_IDS)[number];

const capturableRules = Object.freeze([
  ...executableRules.filter((rule) =>
    rule.supportedAuthorities?.includes("capturable-king/v1") === true
  ),
  ...capturableKingRules,
]);
const rulesById = new Map(
  capturableRules.map((rule) => [rule.id, rule]),
);

if (
  capturableRules.length !== PLAYER_PRIVATE_RULE_IDS.length
  || rulesById.size !== PLAYER_PRIVATE_RULE_IDS.length
  || PLAYER_PRIVATE_RULE_IDS.some((id) => !rulesById.has(id))
) {
  throw new Error(
    "Player-private simulation catalog is out of sync with capturable-king audits.",
  );
}

export function resolvePlayerPrivateRule(
  id: PlayerPrivateRuleId,
): DrawbackRule<unknown, unknown> {
  const rule = rulesById.get(id);
  if (rule === undefined) {
    throw new RangeError(`Unknown player-private rule: ${id}.`);
  }
  return rule;
}
