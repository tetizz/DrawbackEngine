import { describe, expect, it } from "vitest";
import {
  AUDITED_CAPTURABLE_KING_RULE_IDS,
  AUDITED_CAPTURABLE_KING_RULE_IDS_V2,
  AUDITED_CAPTURABLE_KING_RULE_IDS_V3,
  isAuditedCapturableKingRuleId,
  isAuditedCapturableKingRuleIdV3,
  resolveAuditedCapturableKingRule,
  resolveAuditedCapturableKingRuleV3,
  type AuditedCapturableKingRuleId,
} from "./audited-capturable-rules.js";

describe("audited capturable-king rule catalog", () => {
  it("keeps the historical 25-label allowlist frozen", () => {
    expect(AUDITED_CAPTURABLE_KING_RULE_IDS).toBe(
      AUDITED_CAPTURABLE_KING_RULE_IDS_V2,
    );
    expect(Object.isFrozen(AUDITED_CAPTURABLE_KING_RULE_IDS_V2)).toBe(true);
    expect(AUDITED_CAPTURABLE_KING_RULE_IDS_V2).toHaveLength(25);
    expect(new Set(AUDITED_CAPTURABLE_KING_RULE_IDS).size).toBe(
      AUDITED_CAPTURABLE_KING_RULE_IDS.length,
    );
    for (const id of AUDITED_CAPTURABLE_KING_RULE_IDS) {
      const rule = resolveAuditedCapturableKingRule(id);
      expect(rule.id).toBe(id);
      expect(rule.supportedAuthorities).toContain("capturable-king/v1");
      expect(isAuditedCapturableKingRuleId(id)).toBe(true);
    }
    expect(isAuditedCapturableKingRuleId("far-sighted")).toBe(false);
    expect(isAuditedCapturableKingRuleId("not-a-rule")).toBe(false);
  });

  it("exposes the compatibility wave only through the version-three catalog", () => {
    expect(AUDITED_CAPTURABLE_KING_RULE_IDS_V3).toHaveLength(37);
    expect(Object.isFrozen(AUDITED_CAPTURABLE_KING_RULE_IDS_V3)).toBe(true);
    expect(new Set(AUDITED_CAPTURABLE_KING_RULE_IDS_V3).size).toBe(
      AUDITED_CAPTURABLE_KING_RULE_IDS_V3.length,
    );
    expect(AUDITED_CAPTURABLE_KING_RULE_IDS_V3.slice(0, 25)).toEqual(
      AUDITED_CAPTURABLE_KING_RULE_IDS_V2,
    );
    expect(AUDITED_CAPTURABLE_KING_RULE_IDS_V3.slice(25)).toEqual([
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
    ]);
    for (const id of AUDITED_CAPTURABLE_KING_RULE_IDS_V3) {
      const rule = resolveAuditedCapturableKingRuleV3(id);
      expect(rule.id).toBe(id);
      expect(rule.supportedAuthorities).toContain("capturable-king/v1");
      expect(isAuditedCapturableKingRuleIdV3(id)).toBe(true);
    }
    for (const id of AUDITED_CAPTURABLE_KING_RULE_IDS_V3.slice(25)) {
      expect(isAuditedCapturableKingRuleId(id)).toBe(false);
      expect(isAuditedCapturableKingRuleIdV3(id)).toBe(true);
    }
    expect(isAuditedCapturableKingRuleIdV3("not-a-rule")).toBe(false);
    expect(() =>
      resolveAuditedCapturableKingRule(
        "far-sighted" as AuditedCapturableKingRuleId,
      )
    ).toThrowError("Unknown audited capturable-king rule: far-sighted.");
  });
});
