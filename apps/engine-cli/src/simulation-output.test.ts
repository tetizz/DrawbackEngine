import { describe, expect, it } from "vitest";
import { simulateCatalogBatch } from "@drawbackengine/simulation-arena";
import { writeSimulationTraceNdjson } from "./simulation-output.js";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function serialize(seed: number): string {
  const games = simulateCatalogBatch({
    seed,
    games: 2,
    maxPlies: 2,
    ruleIds: ["vegan", "checkers"],
    agentIds: ["random-legal"],
  });
  let output = "";
  const count = writeSimulationTraceNdjson(games, {
    write(chunk) {
      output += chunk;
    },
  });
  expect(count).toBe(2);
  return output;
}

describe("simulation trace output", () => {
  it("writes deterministic, ordered, complete game records", () => {
    const first = serialize(41);
    expect(serialize(41)).toBe(first);
    const lines = first.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const record = JSON.parse(line) as unknown;
      expect(isRecord(record)).toBe(true);
      if (!isRecord(record)) {
        continue;
      }
      expect(typeof record["seed"]).toBe("number");
      expect(Array.isArray(record["plies"])).toBe(true);
      const drawbacks = record["drawbacks"];
      expect(isRecord(drawbacks)).toBe(true);
      if (isRecord(drawbacks)) {
        expect(typeof drawbacks["white"]).toBe("string");
        expect(typeof drawbacks["black"]).toBe("string");
      }
    }
  });
});
