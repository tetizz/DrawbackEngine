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

  it(
    "reports progress without changing trace bytes or digest",
    async () => {
      const withoutProgress = temporaryPath("without-progress");
      const withProgress = temporaryPath("with-progress");
      const createGames = () => streamPlayerPrivateAssignmentsParallel({
        assignments: schedule({ train: 3, validation: 0, test: 0 }),
        workers: 1,
        windowSize: 2,
        policy,
        maxPlies: 1,
      });
      const control = await writePlayerPrivateSplitTraceFileAtomic(
        withoutProgress,
        "train",
        createGames(),
      );
      const progress: {
        readonly split: string;
        readonly games: number;
        readonly bytes: number;
      }[] = [];
      const observed = await writePlayerPrivateSplitTraceFileAtomic(
        withProgress,
        "train",
        createGames(),
        {
          onProgress: (entry) => {
            progress.push(entry);
          },
        },
      );

      expect(await readFile(withProgress)).toEqual(
        await readFile(withoutProgress),
      );
      expect(observed.sha256).toBe(control.sha256);
      expect(observed.bytes).toBe(control.bytes);
      expect(progress).toHaveLength(3);
      expect(progress.at(-1)).toEqual({
        split: "train",
        games: 3,
        bytes: observed.bytes,
      });
    },
    30_000,
  );

  it("does not create output for a pre-aborted write", async () => {
    const path = temporaryPath("pre-aborted");
    const controller = new AbortController();
    controller.abort(new Error("Synthetic pre-aborted write."));
    const games = streamPlayerPrivateAssignmentsParallel({
      assignments: schedule({ train: 1, validation: 0, test: 0 }),
      workers: 1,
      windowSize: 1,
      policy,
      maxPlies: 1,
      signal: controller.signal,
    });

    await expect(writePlayerPrivateSplitTraceFileAtomic(
      path,
      "train",
      games,
      { signal: controller.signal },
    )).rejects.toThrow("Synthetic pre-aborted write");
    await expectPrivateOutputAbsent(path);
  });

  it("removes partial output when interrupted after progress", async () => {
    const path = temporaryPath("aborted-after-progress");
    const controller = new AbortController();
    const games = streamPlayerPrivateAssignmentsParallel({
      assignments: schedule({ train: 3, validation: 0, test: 0 }),
      workers: 1,
      windowSize: 1,
      policy,
      maxPlies: 1,
      signal: controller.signal,
    });

    await expect(writePlayerPrivateSplitTraceFileAtomic(
      path,
      "train",
      games,
      {
        signal: controller.signal,
        onProgress: ({ games: writtenGames }) => {
          if (writtenGames === 1) {
            controller.abort(new Error("Synthetic active write abort."));
          }
        },
      },
    )).rejects.toThrow("Synthetic active write abort");
    await expectPrivateOutputAbsent(path);
  }, 30_000);
});

async function expectPrivateOutputAbsent(path: string): Promise<void> {
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    (await readdir(dirname(path))).some((entry) =>
      entry.startsWith(`${basename(path)}.tmp-`)
    ),
  ).toBe(false);
}

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
