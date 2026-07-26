import { describe, expect, it } from "vitest";
import {
  PLAYER_PRIVATE_RULE_IDS,
  resolvePlayerPrivateRule,
} from "./player-private-catalog.js";

describe("player-private rule catalog", () => {
  it("contains only unique capturable-king-audited rules", () => {
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
