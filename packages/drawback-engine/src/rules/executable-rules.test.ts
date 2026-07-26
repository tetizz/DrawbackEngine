import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  executableRules,
  externalConstraintRules,
  preparedExecutableRules,
  resolveExecutableRule,
  resolvePreparedExecutableRule,
} from "./executable-rules.js";

describe("executable rule catalog", () => {
  it("is unique, complete, and resolvable", () => {
    expect(executableRules).toHaveLength(180);
    expect(new Set(executableRules.map(({ id }) => id)).size).toBe(180);
    for (const rule of executableRules) {
      expect(resolveExecutableRule(rule.id)).toBe(rule);
      expect(rule.verification).not.toBe("unsupported");
    }
  });

  it("registers evaluator-backed rules in the prepared async catalog", () => {
    expect(externalConstraintRules).toHaveLength(2);
    expect(preparedExecutableRules).toHaveLength(182);
    for (const rule of preparedExecutableRules) {
      expect(resolvePreparedExecutableRule(rule.id)).toBe(rule);
    }
  });

  it("fails closed for an unknown rule", () => {
    expect(() => resolveExecutableRule("not-a-real-drawback")).toThrow(
      "Unknown executable drawback rule",
    );
  });

  it("matches every executable entry across machine-readable catalog fragments", () => {
    const fragments = [
      "initial-drawbacks.json",
      "milestone-drawbacks.json",
      "parameterized-drawbacks.json",
      "expanded-drawbacks.json",
      "community-drawbacks.json",
      "community-drawbacks-two.json",
      "loss-drawbacks.json",
      "observed-rules-three.json",
      "observed-rules-four.json",
      "observed-rules-five.json",
      "observed-rules-six.json",
      "observed-rules-seven.json",
      "observed-rules-eight.json",
      "observed-rules-nine.json",
      "observed-rules-ten.json",
      "observed-rules-eleven.json",
      "evaluator-backed-drawbacks.json",
    ];
    const catalog = fragments.flatMap((file) =>
      JSON.parse(readFileSync(
        new URL(`../../../../data/catalog/${file}`, import.meta.url),
        "utf8",
      )) as readonly {
        readonly id: string;
        readonly implementationStatus: string;
      }[],
    );
    const executableIds = catalog
      .filter(({ implementationStatus }) => implementationStatus !== "unsupported")
      .map(({ id }) => id);
    expect([...executableIds].sort()).toEqual(
      preparedExecutableRules.map(({ id }) => id).sort(),
    );
    expect(catalog.filter(
      ({ implementationStatus }) => implementationStatus === "unsupported",
    ).map(({ id }) => id)).toEqual([]);
  });

  it("tracks the full observed glossary without marking unsupported rules executable", () => {
    const catalog = JSON.parse(readFileSync(
      new URL(
        "../../../../data/catalog/observed-drawbacks.json",
        import.meta.url,
      ),
      "utf8",
    )) as {
      readonly counts: {
        readonly observed: number;
        readonly executable: number;
        readonly unsupported: number;
      };
      readonly entries: readonly {
        readonly id: string;
        readonly observedName: string;
        readonly observedDescription: string;
        readonly implementationStatus: string;
      }[];
    };
    expect(catalog.entries).toHaveLength(194);
    expect(catalog.counts).toEqual({
      observed: 194,
      executable: 182,
      unsupported: 12,
    });
    expect(new Set(catalog.entries.map(({ id }) => id)).size).toBe(194);
    expect(catalog.entries.every(
      ({ observedName, observedDescription }) =>
        observedName.length > 0 && observedDescription.length > 0,
    )).toBe(true);
    const executableIds = catalog.entries
      .filter(({ implementationStatus }) => implementationStatus !== "unsupported")
      .map(({ id }) => id)
      .sort();
    expect(executableIds).toEqual(
      preparedExecutableRules.map(({ id }) => id).sort(),
    );
    const statusById = new Map(
      catalog.entries.map(({ id, implementationStatus }) => [
        id,
        implementationStatus,
      ]),
    );
    for (const rule of preparedExecutableRules) {
      expect(
        statusById.get(rule.id),
        `${rule.id} runtime/catalog verification status`,
      ).toBe(rule.verification);
    }
  });
});
