import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  Schema9ProducerRuntimeIdentity,
} from "@drawbackengine/simulation-arena";
import {
  createSchema9PlayerPrivateBundle,
  authenticateSchema9TraceFile,
  assertPathFreeSchema9Receipt,
  ownedSchema9DirectoryIdentity,
  parseSchema9PlayerPrivateCliArguments,
  removeOwnedSchema9Directory,
  verifiedCleanEngineCommit,
  type Schema9PlayerPrivateBundleDependencies,
} from "./schema9-player-private-bundle.js";
import {
  canonicalSchema9RuntimeJson,
  runSchema9AuthenticatedGit,
  runSchema9RuntimeCommandForTesting,
} from "./schema9-runtime-identity.js";
import type {
  PlayerPrivateBatchOptions,
  PlayerPrivateBatchResult,
} from "./player-private-batch.js";

const COMMIT = "a".repeat(40);
const TRACE = Buffer.from('{"game":0}\n', "utf8");
const RUNTIME_IDENTITY_BASE = Object.freeze({
  format: "drawbackengine-schema9-producer-runtime" as const,
  version: 1 as const,
  algorithm: "sha256-engine-runtime-tree-v1" as const,
  runtime: Object.freeze({
    nodeVersion: "v22.17.0",
    platform: "win32",
    architecture: "x64",
    execArgv: Object.freeze([] as const),
  }),
  coordinator: Object.freeze({
    componentId: "schema9-coordinator/v1" as const,
    files: 17,
    bytes: 1_234,
    sha256: "1".repeat(64),
  }),
  parallelWorker: Object.freeze({
    componentId: "player-private-parallel-worker/v1" as const,
    files: 13,
    bytes: 987,
    sha256: "2".repeat(64),
  }),
});
const RUNTIME_IDENTITY = Object.freeze({
  ...RUNTIME_IDENTITY_BASE,
  aggregateSha256: createHash("sha256")
    .update(canonicalSchema9RuntimeJson(RUNTIME_IDENTITY_BASE))
    .digest("hex"),
}) satisfies Schema9ProducerRuntimeIdentity;

describe("schema-9 player-private bundle", () => {
  it("parses only the complete named invocation", () => {
    const options = parseSchema9PlayerPrivateCliArguments([
      "--ledger-split",
      "validation-a",
      "--games",
      "25",
      "--workers",
      "4",
      "--schedule-id",
      "schema9-smoke-v1",
      "--bundle",
      "private/bundle",
      "--engine-repository",
      "engine",
    ], "C:/invocation");

    expect(options).toEqual({
      ledgerSplit: "validation-a",
      games: 25,
      workers: 4,
      scheduleId: "schema9-smoke-v1",
      bundlePath: resolve("C:/invocation", "private/bundle"),
      engineRepository: resolve("C:/invocation", "engine"),
    });
  });

  it.each([
    ["missing flag", ["--ledger-split", "train"]],
    ["unbalanced games", validArguments({ games: "24" })],
    ["excessive workers", validArguments({ workers: "257" })],
    ["invalid schedule ID", validArguments({ scheduleId: "bad/id" })],
    ["ambiguous schedule ID", validArguments({ scheduleId: "a..b" })],
    ["reserved schedule ID", validArguments({ scheduleId: "con" })],
    ["private schedule ID", validArguments({ scheduleId: "secret-run" })],
    [
      "duplicate flag",
      [
        ...validArguments(),
        "--games",
        "25",
      ],
    ],
  ] as const)("rejects an invocation with %s", (_label, arguments_) => {
    expect(() => parseSchema9PlayerPrivateCliArguments(arguments_)).toThrow();
  });

  it("publishes authenticated receipts around the exact trace bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-bundle-test-"));
    const bundlePath = join(root, "published");
    try {
      const result = await createSchema9PlayerPrivateBundle({
        ledgerSplit: "validation-b",
        games: 25,
        workers: 3,
        scheduleId: "schema9-smoke-v1",
        bundlePath,
        producerEngineCommit: COMMIT,
        producerRuntimeIdentity: RUNTIME_IDENTITY,
      }, fakeBatch());

      expect(await readdir(bundlePath)).toEqual([
        "completion.json",
        "launch.json",
        "trace.ndjson",
      ]);
      expect(await readFile(join(bundlePath, "trace.ndjson"))).toEqual(TRACE);

      const launchBytes = await readFile(join(bundlePath, "launch.json"));
      const launch = JSON.parse(launchBytes.toString("utf8")) as {
        readonly format: string;
        readonly version: number;
        readonly scheduleAuthorityId: string;
        readonly scheduleId: string;
        readonly ledgerSplit: string;
        readonly engineSplit: string;
        readonly splitCounts: Readonly<Record<string, number>>;
        readonly seedRoots: readonly number[];
        readonly scheduleProfile: Readonly<Record<string, string>>;
        readonly generationConfig: Readonly<Record<string, unknown>>;
        readonly producerEngineCommit: string;
        readonly producerRuntimeIdentity: Schema9ProducerRuntimeIdentity;
      };
      expect(launch).toMatchObject({
        format: "drawbackengine-player-private-schedule-launch",
        version: 3,
        scheduleAuthorityId: "capturable25-schema9-opportunity/v1",
        scheduleId: "schema9-smoke-v1",
        ledgerSplit: "validation-b",
        engineSplit: "train",
        splitCounts: { train: 25, validation: 0, test: 0 },
        seedRoots: [3_786_384_219, 3_547_865_132, 2_689_552_677],
        scheduleProfile: {
          id: "standard",
          policyId: "material-player-private-corpus/v1",
        },
        generationConfig: {
          maxPlies: 120,
          maxDepth: 2,
          maxNodes: 50_000,
          temperatureCp: 35,
          topK: 8,
          leafCacheEntries: 16_384,
          leafCacheHistoryMode: "full",
          opponentAggregation: "worst-case",
          evaluator: {
            kind: "material",
            version: 1,
            evaluatorId: "drawback-material/v1",
          },
          opponentHypotheses: {
            kind: "unrestricted-baseline",
            version: 1,
          },
        },
        producerEngineCommit: COMMIT,
        producerRuntimeIdentity: RUNTIME_IDENTITY,
      });

      const completion = JSON.parse(await readFile(
        join(bundlePath, "completion.json"),
        "utf8",
      )) as {
        readonly state: string;
        readonly launchReceiptSha256: string;
        readonly output: Readonly<{
          sha256: string;
          bytes: number;
          games: number;
          firstGameIndex: number;
          lastGameIndex: number;
        }>;
        readonly producerRuntimeIdentity: Schema9ProducerRuntimeIdentity;
      };
      const traceSha256 = createHash("sha256").update(TRACE).digest("hex");
      expect(completion).toMatchObject({
        state: "completed",
        producerRuntimeIdentity: RUNTIME_IDENTITY,
        launchReceiptSha256: createHash("sha256")
          .update(launchBytes)
          .digest("hex"),
        output: {
          sha256: traceSha256,
          bytes: TRACE.length,
          games: 25,
          firstGameIndex: 0,
          lastGameIndex: 24,
        },
      });
      expect(result.output).toEqual(completion.output);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not clobber an existing bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-no-clobber-test-"));
    const bundlePath = join(root, "published");
    const sentinel = join(bundlePath, "keep.txt");
    try {
      await mkdir(bundlePath);
      await writeFile(sentinel, "keep", "utf8");
      await expect(createSchema9PlayerPrivateBundle(baseOptions(bundlePath),
        fakeBatch())).rejects.toThrow("already exists");
      expect(await readFile(sentinel, "utf8")).toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes temporary output when generation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-failure-test-"));
    const bundlePath = join(root, "published");
    try {
      const failing: Schema9PlayerPrivateBundleDependencies = {
        ...fakeBatch(),
        runBatch: async (options) => {
          await writeFile(options.outputPath, TRACE);
          throw new Error("injected batch failure");
        },
      };
      await expect(createSchema9PlayerPrivateBundle(
        baseOptions(bundlePath),
        failing,
      )).rejects.toThrow("injected batch failure");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a batch result that does not authenticate the trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-auth-test-"));
    const bundlePath = join(root, "published");
    try {
      const mismatched = fakeBatch({ sha256: "0".repeat(64) });
      await expect(createSchema9PlayerPrivateBundle(
        baseOptions(bundlePath),
        mismatched,
      )).rejects.toThrow("do not match");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a realized policy that differs from the receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-policy-test-"));
    const bundlePath = join(root, "published");
    try {
      const mismatched = fakeBatch({
        generationConfig: {
          ...generationConfig(),
          maxDepth: 3,
        },
      });
      await expect(createSchema9PlayerPrivateBundle(
        baseOptions(bundlePath),
        mismatched,
      )).rejects.toThrow("fixed profile");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed if the producer commit changes before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-drift-test-"));
    const bundlePath = join(root, "published");
    let verifications = 0;
    try {
      const drifting: Schema9PlayerPrivateBundleDependencies = {
        ...fakeBatch(),
        verifyProducerCommit: () => {
          verifications += 1;
          return Promise.resolve(
            verifications === 1 ? COMMIT : "b".repeat(40),
          );
        },
      };
      await expect(createSchema9PlayerPrivateBundle(
        baseOptions(bundlePath),
        drifting,
      )).rejects.toThrow("changed during generation");
      expect(verifications).toBe(2);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed if executing runtime bytes change before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-drift-test-"));
    const bundlePath = join(root, "published");
    let verifications = 0;
    try {
      const changed = Object.freeze({
        ...RUNTIME_IDENTITY,
        coordinator: Object.freeze({
          ...RUNTIME_IDENTITY.coordinator,
          sha256: "3".repeat(64),
        }),
      });
      const changedIdentity = Object.freeze({
        ...changed,
        aggregateSha256: createHash("sha256")
          .update(canonicalSchema9RuntimeJson({
            format: changed.format,
            version: changed.version,
            algorithm: changed.algorithm,
            runtime: changed.runtime,
            coordinator: changed.coordinator,
            parallelWorker: changed.parallelWorker,
          }))
          .digest("hex"),
      }) satisfies Schema9ProducerRuntimeIdentity;
      const drifting: Schema9PlayerPrivateBundleDependencies = {
        ...fakeBatch(),
        verifyProducerRuntimeIdentity: () => {
          verifications += 1;
          return Promise.resolve(
            verifications < 3 ? RUNTIME_IDENTITY : changedIdentity,
          );
        },
      };
      await expect(createSchema9PlayerPrivateBundle(
        baseOptions(bundlePath),
        drifting,
      )).rejects.toThrow("isolated clean rebuild");
      expect(verifications).toBe(3);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects same-owner output mutation immediately before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-final-mutation-test-"));
    const bundlePath = join(root, "published");
    try {
      const mutating: Schema9PlayerPrivateBundleDependencies = {
        ...fakeBatch(),
        beforeFinalBundleAuthentication: async (temporaryPath) => {
          await writeFile(
            join(temporaryPath, "trace.ndjson"),
            Buffer.from('{"mutated":true}\n', "utf8"),
          );
        },
      };
      await expect(createSchema9PlayerPrivateBundle(
        baseOptions(bundlePath),
        mutating,
      )).rejects.toThrow("changed before publication");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects mutation by the final runtime verifier before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-verifier-mutation-test-"));
    const bundlePath = join(root, "published");
    let temporaryPath: string | undefined;
    let verifications = 0;
    try {
      const mutating: Schema9PlayerPrivateBundleDependencies = {
        ...fakeBatch(),
        beforeFinalBundleAuthentication: (path) => {
          temporaryPath = path;
          return Promise.resolve();
        },
        verifyProducerRuntimeIdentity: async () => {
          verifications += 1;
          if (verifications === 3) {
            if (temporaryPath === undefined) {
              throw new Error("missing temporary bundle test seam");
            }
            await writeFile(
              join(temporaryPath, "trace.ndjson"),
              Buffer.from('{"mutated-by-verifier":true}\n', "utf8"),
            );
          }
          return RUNTIME_IDENTITY;
        },
      };
      await expect(createSchema9PlayerPrivateBundle(
        baseOptions(bundlePath),
        mutating,
      )).rejects.toThrow("changed before publication");
      expect(verifications).toBe(3);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back the unpublished bundle when interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-abort-test-"));
    const bundlePath = join(root, "published");
    const controller = new AbortController();
    try {
      const interrupted = fakeBatch({}, () => {
        controller.abort(new Error("injected interruption"));
      });
      await expect(createSchema9PlayerPrivateBundle({
        ...baseOptions(bundlePath),
        signal: controller.signal,
      }, interrupted)).rejects.toThrow("injected interruption");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to place a private bundle inside the Engine checkout", async () => {
    const bundlePath = join(process.cwd(), "schema9-private-test-output");
    await expect(createSchema9PlayerPrivateBundle(
      baseOptions(bundlePath),
      fakeBatch(),
    )).rejects.toThrow("outside the repository");
    await expect(access(bundlePath)).rejects.toThrow();
  });

  it("refuses an outside junction that resolves into the Engine checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-junction-test-"));
    const linkedRepository = join(root, "linked-repository");
    const repository = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const leaf = `schema9-junction-output-${String(process.pid)}`;
    try {
      await symlink(
        repository,
        linkedRepository,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(createSchema9PlayerPrivateBundle(
        baseOptions(join(linkedRepository, leaf)),
        fakeBatch(),
      )).rejects.toThrow("outside the repository");
      await expect(access(join(repository, leaf))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("schema-9 bundle ownership and hashing", () => {
  it("distinguishes delimited account data from fixed schema words", () => {
    expect(() => {
      assertPathFreeSchema9Receipt(
        { seedRoots: [1, 2, 3] },
        "receipt",
        ["root"],
      );
    }).not.toThrow();
    expect(() => {
      assertPathFreeSchema9Receipt(
        { value: "deeplyRooted" },
        "receipt",
        ["root"],
      );
    }).not.toThrow();
    expect(() => {
      assertPathFreeSchema9Receipt(
        { value: "𐐀root𐐀" },
        "receipt",
        ["root"],
      );
    }).not.toThrow();
    expect(() => {
      assertPathFreeSchema9Receipt(
        { scheduleId: "run-root-v1" },
        "receipt",
        ["root"],
      );
    }).toThrow("private path or user data");
    expect(() => {
      assertPathFreeSchema9Receipt(
        { root: true },
        "receipt",
        ["root"],
      );
    }).toThrow("private path or user data");
  });

  it("does not delete a replacement at a retained cleanup path", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-owner-test-"));
    const owned = join(root, "owned");
    const sentinel = join(owned, "replacement.txt");
    try {
      await mkdir(owned);
      const identity = await ownedSchema9DirectoryIdentity(owned);
      await rm(owned, { recursive: true });
      await mkdir(owned);
      await writeFile(sentinel, "replacement", "utf8");

      await expect(removeOwnedSchema9Directory(owned, identity))
        .rejects.toThrow("no longer the owned directory");
      expect(await readFile(sentinel, "utf8")).toBe("replacement");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("interrupts final trace authentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-hash-abort-test-"));
    const tracePath = join(root, "trace.ndjson");
    const controller = new AbortController();
    try {
      await writeFile(tracePath, Buffer.alloc(16 * 1024 * 1024, 0x61));
      const authentication = authenticateSchema9TraceFile(
        tracePath,
        controller.signal,
      );
      setImmediate(() => {
        controller.abort(new Error("hash interruption"));
      });
      await expect(authentication).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("schema-9 producer provenance", () => {
  it("accepts a clean exact checkout and rejects dirty or hidden state", async () => {
    const repository = await mkdtemp(join(tmpdir(), "schema9-git-test-"));
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(new Error("Schema-9 provenance test deadline expired."));
    }, 60_000);
    try {
      git(repository, ["init"]);
      git(repository, ["config", "user.name", "tetizz"]);
      git(repository, [
        "config",
        "user.email",
        "104690265+tetizz@users.noreply.github.com",
      ]);
      await writeFile(join(repository, "tracked.txt"), "one\n", "utf8");
      git(repository, ["add", "tracked.txt"]);
      git(repository, ["commit", "-m", "Initial test state"]);
      const commit = git(repository, ["rev-parse", "HEAD"]).trim();

      await expect(verifiedCleanEngineCommit(
        repository,
        repository,
        controller.signal,
      ))
        .resolves.toBe(commit);

      await writeFile(join(repository, "untracked.txt"), "dirty\n", "utf8");
      await expect(verifiedCleanEngineCommit(
        repository,
        repository,
        controller.signal,
      ))
        .rejects.toThrow("not clean");
      await rm(join(repository, "untracked.txt"));

      git(repository, ["update-index", "--assume-unchanged", "tracked.txt"]);
      await expect(verifiedCleanEngineCommit(
        repository,
        repository,
        controller.signal,
      ))
        .rejects.toThrow("hidden index flags");
    } finally {
      clearTimeout(deadline);
      await rm(repository, { recursive: true, force: true });
    }
  }, 70_000);

  it("rejects a different checkout than the executing source", async () => {
    const supplied = await mkdtemp(join(tmpdir(), "schema9-other-git-test-"));
    const executing = await mkdtemp(join(tmpdir(), "schema9-own-git-test-"));
    try {
      await expect(verifiedCleanEngineCommit(supplied, executing))
        .rejects.toThrow("not the executing source checkout");
    } finally {
      await rm(supplied, { recursive: true, force: true });
      await rm(executing, { recursive: true, force: true });
    }
  });

  it("ignores a caller PATH that shadows the system Git executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-shadow-git-test-"));
    const repository = join(root, "repository");
    const shadow = join(root, "shadow");
    try {
      await mkdir(repository);
      git(repository, ["init"]);
      git(repository, ["config", "user.name", "tetizz"]);
      git(repository, [
        "config",
        "user.email",
        "104690265+tetizz@users.noreply.github.com",
      ]);
      await writeFile(join(repository, "tracked.txt"), "one\n", "utf8");
      git(repository, ["add", "tracked.txt"]);
      git(repository, ["commit", "-m", "Shadow test state"]);
      const commit = git(repository, ["rev-parse", "HEAD"]).trim();
      await mkdir(shadow);
      const fakeGit = join(
        shadow,
        process.platform === "win32" ? "git.exe" : "git",
      );
      await writeFile(fakeGit, "not-the-system-git\n", "utf8");
      if (process.platform !== "win32") {
        await chmod(fakeGit, 0o755);
      }

      await expect(runHostileEnvironmentCommitVerification({
        repository,
        shadowPath: shadow,
        gitDirectory: join(root, "attacker-git-dir"),
        systemRoot: join(root, "attacker-windows"),
      }))
        .resolves.toBe(commit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 70_000);

  it("does not execute a repository core.fsmonitor command", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-fsmonitor-test-"));
    const repository = join(root, "repository");
    const marker = join(root, "fsmonitor-executed.txt");
    const monitor = join(root, "malicious.sh");
    try {
      await mkdir(repository);
      git(repository, ["init"]);
      git(repository, ["config", "user.name", "tetizz"]);
      git(repository, [
        "config",
        "user.email",
        "104690265+tetizz@users.noreply.github.com",
      ]);
      await writeFile(join(repository, "tracked.txt"), "one\n", "utf8");
      git(repository, ["add", "tracked.txt"]);
      git(repository, ["commit", "-m", "Fsmonitor test state"]);
      const commit = git(repository, ["rev-parse", "HEAD"]).trim();
      const shellMarker = marker.replaceAll("\\", "/");
      const command = `#!/bin/sh\nprintf fsmonitor-executed > '${shellMarker}'\n`;
      await writeFile(monitor, command, "utf8");
      await chmod(monitor, 0o755);
      git(repository, [
        "config",
        "core.fsmonitor",
        monitor.replaceAll("\\", "/"),
      ]);

      git(repository, ["status", "--porcelain=v1"]);
      await expect(access(marker)).resolves.toBeUndefined();
      await rm(marker);

      await runSchema9AuthenticatedGit(
        [
          "--no-replace-objects",
          "-c",
          `core.fsmonitor=${monitor.replaceAll("\\", "/")}`,
          "-C",
          repository,
          "status",
          "--porcelain=v1",
        ],
        repository,
      );
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });

      await expect(verifiedCleanEngineCommit(repository, repository))
        .resolves.toBe(commit);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 70_000);

  it("rejects repository clean filters before executing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-filter-test-"));
    const repository = join(root, "repository");
    const marker = join(root, "filter-executed.txt");
    const filter = join(root, "malicious-filter.sh");
    try {
      await mkdir(repository);
      git(repository, ["init"]);
      git(repository, ["config", "user.name", "tetizz"]);
      git(repository, [
        "config",
        "user.email",
        "104690265+tetizz@users.noreply.github.com",
      ]);
      await writeFile(
        join(repository, ".gitattributes"),
        "tracked.txt filter=marker\n",
        "utf8",
      );
      await writeFile(join(repository, "tracked.txt"), "one\n", "utf8");
      git(repository, ["add", ".gitattributes", "tracked.txt"]);
      git(repository, ["commit", "-m", "Filter test state"]);
      const shellMarker = marker.replaceAll("\\", "/");
      await writeFile(
        filter,
        `#!/bin/sh\nprintf filter-executed > '${shellMarker}'\ncat\n`,
        "utf8",
      );
      await chmod(filter, 0o755);
      git(repository, [
        "config",
        "filter.marker.clean",
        filter.replaceAll("\\", "/"),
      ]);
      await writeFile(join(repository, "tracked.txt"), "two\n", "utf8");

      git(repository, ["status", "--porcelain=v1"]);
      await expect(access(marker)).resolves.toBeUndefined();
      await rm(marker);

      await expect(verifiedCleanEngineCommit(repository, repository))
        .rejects.toThrow("process-bearing filter configuration");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function runHostileEnvironmentCommitVerification(input: Readonly<{
  repository: string;
  shadowPath: string;
  gitDirectory: string;
  systemRoot: string;
}>): Promise<string> {
  const moduleUrl = pathToFileURL(fileURLToPath(
    new URL("./schema9-player-private-bundle.ts", import.meta.url),
  )).href;
  const sourceLoader = new URL(
    "../node_modules/tsx/dist/loader.mjs",
    import.meta.url,
  ).href;
  const wrapper = String.raw`
const moduleUrl = process.argv[2];
const repository = process.argv[3];
process.env.PATH = process.argv[4];
process.env.GIT_DIR = process.argv[5];
process.env.SystemRoot = process.argv[6];
const { verifiedCleanEngineCommit } = await import(moduleUrl);
const commit = await verifiedCleanEngineCommit(repository, repository);
process.stdout.write(commit);
`;
  const output = await runSchema9RuntimeCommandForTesting(
    process.execPath,
    [
      "--import",
      sourceLoader,
      "--input-type=module",
      "--eval",
      wrapper,
      "schema9-hostile-environment-wrapper",
      moduleUrl,
      input.repository,
      input.shadowPath,
      input.gitDirectory,
      input.systemRoot,
    ],
    input.repository,
    undefined,
    60_000,
  );
  return output.trim();
}

function validArguments(overrides: Readonly<{
  games?: string;
  workers?: string;
  scheduleId?: string;
}> = {}): readonly string[] {
  return [
    "--ledger-split",
    "train",
    "--games",
    overrides.games ?? "25",
    "--workers",
    overrides.workers ?? "1",
    "--schedule-id",
    overrides.scheduleId ?? "schema9-smoke-v1",
    "--bundle",
    "bundle",
    "--engine-repository",
    "engine",
  ];
}

function baseOptions(bundlePath: string) {
  return {
    ledgerSplit: "train" as const,
    games: 25,
    workers: 1,
    scheduleId: "schema9-smoke-v1",
    bundlePath,
    producerEngineCommit: COMMIT,
    producerRuntimeIdentity: RUNTIME_IDENTITY,
  };
}

function fakeBatch(
  overrides: Partial<PlayerPrivateBatchResult> = {},
  afterWrite?: () => void,
): Schema9PlayerPrivateBundleDependencies {
  return {
    runBatch: async (
      options: PlayerPrivateBatchOptions,
    ): Promise<PlayerPrivateBatchResult> => {
      await mkdir(dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, TRACE, { flag: "wx" });
      afterWrite?.();
      return {
        split: "train",
        games: 25,
        firstGameIndex: 0,
        lastGameIndex: 24,
        bytes: TRACE.length,
        sha256: createHash("sha256").update(TRACE).digest("hex"),
        evaluatorId: "drawback-material/v1",
        profile: {
          id: "standard",
          policyId: "material-player-private-corpus/v1",
        },
        generationConfig: generationConfig(),
        ...overrides,
      };
    },
    verifyProducerCommit: () => Promise.resolve(COMMIT),
    verifyProducerRuntimeIdentity: () => Promise.resolve(RUNTIME_IDENTITY),
  };
}

function generationConfig(): PlayerPrivateBatchResult["generationConfig"] {
  return {
    maxPlies: 120,
    maxDepth: 2,
    maxNodes: 50_000,
    temperatureCp: 35,
    topK: 8,
    leafCacheEntries: 16_384,
    leafCacheHistoryMode: "full",
    opponentAggregation: "worst-case",
    evaluator: {
      kind: "material",
      version: 1,
      evaluatorId: "drawback-material/v1",
    },
    opponentHypotheses: {
      kind: "unrestricted-baseline",
      version: 1,
    },
  };
}

function git(repository: string, arguments_: readonly string[]): string {
  return execFileSync(
    "git",
    ["-C", repository, ...arguments_],
    { encoding: "utf8", windowsHide: true },
  );
}
