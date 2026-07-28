import { describe, expect, it } from "vitest";
import {
  AUDITED_CAPTURABLE_KING_RULE_IDS,
  AUDITED_CAPTURABLE_KING_RULE_IDS_V2,
  AUDITED_CAPTURABLE_KING_RULE_IDS_V3,
  AUDITED_CAPTURABLE_KING_RULE_IDS_V4,
  isAuditedCapturableKingRuleId,
  isAuditedCapturableKingRuleIdV3,
  isAuditedCapturableKingRuleIdV4,
  resolveAuditedCapturableKingRule,
  resolveAuditedCapturableKingRuleV3,
  resolveAuditedCapturableKingRuleV4,
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

  it("adds five rules only through the frozen version-four catalog", () => {
    expect(AUDITED_CAPTURABLE_KING_RULE_IDS_V4).toHaveLength(42);
    expect(Object.isFrozen(AUDITED_CAPTURABLE_KING_RULE_IDS_V4)).toBe(true);
    expect(new Set(AUDITED_CAPTURABLE_KING_RULE_IDS_V4).size).toBe(
      AUDITED_CAPTURABLE_KING_RULE_IDS_V4.length,
    );
    expect(AUDITED_CAPTURABLE_KING_RULE_IDS_V4.slice(0, 37)).toEqual(
      AUDITED_CAPTURABLE_KING_RULE_IDS_V3,
    );
    expect(AUDITED_CAPTURABLE_KING_RULE_IDS_V4.slice(37)).toEqual([
      "greedy",
      "out-of-breath",
      "queen-bee",
      "alternator",
      "hopscotch",
    ]);
    for (const id of AUDITED_CAPTURABLE_KING_RULE_IDS_V4) {
      const rule = resolveAuditedCapturableKingRuleV4(id);
      expect(rule.id).toBe(id);
      expect(rule.verification).toBe("implemented-unverified");
      expect(rule.supportedAuthorities).toContain("capturable-king/v1");
      expect(isAuditedCapturableKingRuleIdV4(id)).toBe(true);
    }
    for (const id of AUDITED_CAPTURABLE_KING_RULE_IDS_V4.slice(37)) {
      expect(isAuditedCapturableKingRuleId(id)).toBe(false);
      expect(isAuditedCapturableKingRuleIdV3(id)).toBe(false);
      expect(isAuditedCapturableKingRuleIdV4(id)).toBe(true);
    }
    expect(isAuditedCapturableKingRuleIdV4("not-a-rule")).toBe(false);
    expect(() =>
      resolveAuditedCapturableKingRuleV3(
        "alternator" as typeof AUDITED_CAPTURABLE_KING_RULE_IDS_V3[number],
      )
    ).toThrowError(
      "Unknown audited capturable-king v3 rule: alternator.",
    );
  });
});
