import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlayerPrivateAssignmentSchedule,
  streamPlayerPrivateAssignmentsParallel,
} from "@drawbackengine/simulation-arena";
import {
  parsePlayerPrivateSimulationTraceLine,
} from "@drawbackengine/simulation-trace";
import type {
  PlayerPrivateSearchPolicy,
} from "@drawbackengine/simulation-arena";
import {
  writePlayerPrivateSplitTraceFileAtomic,
} from "./player-private-output.js";

const cleanupPaths: string[] = [];
const policy: PlayerPrivateSearchPolicy = {
  policyId: "output-material-search-v1",
  maxDepth: 1,
  maxNodes: 2_000,
  temperatureCp: 35,
  leafCacheEntries: 1_024,
  leafCacheHistoryMode: "full",
  evaluator: { kind: "material", version: 1 },
  opponentHypotheses: {
    kind: "unrestricted-baseline",
    version: 1,
  },
};

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { force: true })),
  );
});

describe("player-private split trace output", () => {
  it(
    "atomically streams ordered replay-verified traces with a digest",
    async () => {
      const path = temporaryPath("train");
      const games = streamPlayerPrivateAssignmentsParallel({
        assignments: schedule({ train: 3, validation: 0, test: 0 }),
        workers: 2,
        windowSize: 2,
        policy,
        maxPlies: 2,
      });
      const written = await writePlayerPrivateSplitTraceFileAtomic(
        path,
        "train",
        games,
      );
      const bytes = await readFile(path);
      const lines = bytes.toString("utf8").trimEnd().split("\n");

      expect(written).toEqual({
        split: "train",
        games: 3,
        firstGameIndex: 0,
        lastGameIndex: 2,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(lines.map((line) =>
        parsePlayerPrivateSimulationTraceLine(line).gameIndex
      )).toEqual([0, 1, 2]);
    },
    30_000,
  );

  it(
    "removes partial output when a different split enters the stream",
    async () => {
      const path = temporaryPath("mixed");
      const games = streamPlayerPrivateAssignmentsParallel({
        assignments: schedule({ train: 1, validation: 1, test: 0 }),
        workers: 1,
        windowSize: 2,
        policy,
        maxPlies: 1,
      });
      await expect(
        writePlayerPrivateSplitTraceFileAtomic(path, "train", games),
      ).rejects.toThrow("received validation");
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await readdir(dirname(path))).some((entry) =>
          entry.startsWith(`${basename(path)}.tmp-`)
        ),
      ).toBe(false);
    },
    30_000,
  );
});

function schedule(splitCounts: {
  readonly train: number;
  readonly validation: number;
  readonly test: number;
}) {
  return createPlayerPrivateAssignmentSchedule({
    splitCounts,
    labelSeed: 101,
    gameplaySeed: 202,
    parameterSeed: 303,
  });
}

function temporaryPath(label: string): string {
  const path = join(
    tmpdir(),
    `drawback-engine-player-private-${label}-${randomUUID()}.ndjson`,
  );
  cleanupPaths.push(path);
  return path;
}
