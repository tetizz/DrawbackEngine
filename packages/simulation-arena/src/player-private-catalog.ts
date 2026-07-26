import {
  AUDITED_CAPTURABLE_KING_RULE_IDS,
  resolveAuditedCapturableKingRule,
  type AuditedCapturableKingRuleId,
} from "@drawbackengine/drawback-engine";

export const PLAYER_PRIVATE_RULE_IDS =
  AUDITED_CAPTURABLE_KING_RULE_IDS;

export type PlayerPrivateRuleId = AuditedCapturableKingRuleId;

export function resolvePlayerPrivateRule(
  id: PlayerPrivateRuleId,
): ReturnType<typeof resolveAuditedCapturableKingRule> {
  return resolveAuditedCapturableKingRule(id);
}
