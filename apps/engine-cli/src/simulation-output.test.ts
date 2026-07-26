import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  simulateCatalogBatch,
  type SimulationResult,
} from "@drawbackengine/simulation-arena";
import {
  writeSimulationTraceNdjson,
  writeSimulationTraceNdjsonFileAtomic,
} from "./simulation-output.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { force: true })),
  );
});

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
      expect(record["format"]).toBe("drawbackengine-private-simulation-trace");
      expect(record["schemaVersion"]).toBe(1);
      expect(record["authorityId"]).toBe("standard-chess/v1");
      expect(typeof record["gameId"]).toBe("string");
      expect(typeof record["initialFen"]).toBe("string");
      expect(Array.isArray(record["plies"])).toBe(true);
      const drawbacks = record["drawbacks"];
      expect(isRecord(drawbacks)).toBe(true);
      if (isRecord(drawbacks)) {
        expect(typeof drawbacks["white"]).toBe("string");
        expect(typeof drawbacks["black"]).toBe("string");
      }
    }
  });

  it("keeps ordered shard bytes identical to one monolithic export", () => {
    const games = simulateCatalogBatch({
      seed: 52,
      games: 2,
      maxPlies: 2,
      ruleIds: ["vegan"],
      agentIds: ["random-legal"],
    });
    const render = (
      selected: typeof games,
      gameIndexOffset = 0,
    ): string => {
      let output = "";
      writeSimulationTraceNdjson(
        selected,
        { write: (chunk) => { output += chunk; } },
        { gameIndexOffset },
      );
      return output;
    };
    expect(render(games)).toBe(
      render(games.slice(0, 1)) + render(games.slice(1), 1),
    );
    expect(() => render(games, -1)).toThrow("gameIndexOffset");
    expect(() => render(games, Number.MAX_SAFE_INTEGER)).toThrow(
      "safe integers",
    );
  });

  it("atomically publishes content-addressed bytes and refuses overwrite", async () => {
    const path = join(
      tmpdir(),
      `drawback-engine-trace-${randomUUID()}.ndjson`,
    );
    cleanupPaths.push(path);
    const games = simulateCatalogBatch({
      seed: 61,
      games: 2,
      maxPlies: 2,
      ruleIds: ["checkers"],
      agentIds: ["random-legal"],
    });
    const written = await writeSimulationTraceNdjsonFileAtomic(path, games);
    const bytes = await readFile(path);
    expect(written).toEqual({
      games: 2,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await expect(
      writeSimulationTraceNdjsonFileAtomic(path, games),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path)).toEqual(bytes);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(
      (await readdir(dirname(path))).some((entry) =>
        entry.startsWith(`${basename(path)}.tmp-`)
      ),
    ).toBe(false);
  });

  it("removes partial output when a later game fails validation", async () => {
    const path = join(
      tmpdir(),
      `drawback-engine-invalid-trace-${randomUUID()}.ndjson`,
    );
    cleanupPaths.push(path);
    const games = simulateCatalogBatch({
      seed: 71,
      games: 2,
      maxPlies: 2,
      ruleIds: ["vegan"],
      agentIds: ["random-legal"],
    });
    const first = games[0];
    const second = games[1];
    if (first === undefined || second === undefined) {
      throw new Error("Expected two simulated games.");
    }
    const invalid: SimulationResult = {
      ...second,
      finalFen: second.initialFen,
    };

    await expect(
      writeSimulationTraceNdjsonFileAtomic(path, [first, invalid]),
    ).rejects.toThrow("finalFen");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(dirname(path))).some((entry) =>
        entry.startsWith(`${basename(path)}.tmp-`)
      ),
    ).toBe(false);
  });
});
