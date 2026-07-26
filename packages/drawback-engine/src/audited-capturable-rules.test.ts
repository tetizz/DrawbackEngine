import { describe, expect, it } from "vitest";
import {
  AUDITED_CAPTURABLE_KING_RULE_IDS,
  isAuditedCapturableKingRuleId,
  resolveAuditedCapturableKingRule,
} from "./audited-capturable-rules.js";

describe("audited capturable-king rule catalog", () => {
  it("resolves exactly the unique authority-audited allowlist", () => {
    expect(new Set(AUDITED_CAPTURABLE_KING_RULE_IDS).size).toBe(
      AUDITED_CAPTURABLE_KING_RULE_IDS.length,
    );
    for (const id of AUDITED_CAPTURABLE_KING_RULE_IDS) {
      const rule = resolveAuditedCapturableKingRule(id);
      expect(rule.id).toBe(id);
      expect(rule.supportedAuthorities).toContain("capturable-king/v1");
      expect(isAuditedCapturableKingRuleId(id)).toBe(true);
    }
    expect(isAuditedCapturableKingRuleId("not-a-rule")).toBe(false);
  });
});
