import { describe, expect, it } from "vitest";
import {
  PLAYER_PRIVATE_RULE_IDS,
  resolvePlayerPrivateRule,
} from "./player-private-catalog.js";

describe("player-private rule catalog", () => {
  it("keeps the historical version-two catalog at exactly 25 rules", () => {
    expect(PLAYER_PRIVATE_RULE_IDS).toHaveLength(25);
    expect(PLAYER_PRIVATE_RULE_IDS).not.toContain("far-sighted");
    expect(new Set(PLAYER_PRIVATE_RULE_IDS).size).toBe(
      PLAYER_PRIVATE_RULE_IDS.length,
    );
    for (const id of PLAYER_PRIVATE_RULE_IDS) {
      const rule = resolvePlayerPrivateRule(id);
      expect(rule.id).toBe(id);
      expect(rule.supportedAuthorities).toContain("capturable-king/v1");
    }
  });
});
