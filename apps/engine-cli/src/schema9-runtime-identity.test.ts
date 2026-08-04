import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  IncompleteSameOwnerCleanupError,
} from "@drawbackengine/chess-evaluator";
import { describe, expect, it } from "vitest";
import type {
  Schema9ProducerRuntimeIdentity,
  Schema9RuntimeDescriptor,
} from "@drawbackengine/simulation-arena";
import { findRetainedCleanupOwner } from "./retained-cleanup.js";
import {
  assertSameSchema9ProducerRuntimeIdentity,
  assertSchema9ProducerRuntimeIdentity,
  attestSchema9ProducerRuntime,
  canonicalSchema9RuntimeJson,
  computeSchema9ProducerRuntimeIdentity,
  ownedRuntimeDirectoryIdentity,
  removeOwnedRuntimeDirectory,
  runSchema9AuthenticatedGit,
  runSchema9RuntimeCommandForTesting,
  schema9SanitizedChildEnvironmentForTesting,
  schema9RuntimeDescriptor,
} from "./schema9-runtime-identity.js";

const WORKSPACE_PACKAGES = Object.freeze([
  "packages/shared",
  "packages/probe-search",
  "packages/drawback-engine",
  "packages/chess-core",
  "packages/drawback-search",
  "packages/chess-evaluator",
  "packages/simulation-trace",
  "packages/simulation-arena",
  "apps/engine-cli",
] as const);
const WORKSPACE_PACKAGE_NAMES = Object.freeze({
  "packages/shared": "@drawbackengine/shared",
  "packages/probe-search": "@drawbackengine/probe-search",
  "packages/drawback-engine": "@drawbackengine/drawback-engine",
  "packages/chess-core": "@drawbackengine/chess-core",
  "packages/drawback-search": "@drawbackengine/drawback-search",
  "packages/chess-evaluator": "@drawbackengine/chess-evaluator",
  "packages/simulation-trace": "@drawbackengine/simulation-trace",
  "packages/simulation-arena": "@drawbackengine/simulation-arena",
  "apps/engine-cli": "@drawbackengine/cli",
} satisfies Readonly<Record<(typeof WORKSPACE_PACKAGES)[number], string>>);
const RUNTIME = Object.freeze({
  nodeVersion: "v22.17.0",
  platform: "win32",
  architecture: "x64",
  execArgv: Object.freeze([] as const),
}) satisfies Schema9RuntimeDescriptor;
const COMMIT = "a".repeat(40);
const TYPESCRIPT_COMPILER = createRequire(import.meta.url).resolve(
  "typescript/lib/tsc.js",
);
const BUILD_ARTIFACT_NORMALIZER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
  "normalize-built-artifacts.mjs",
);

describe("schema-9 producer runtime identity", () => {
  it("matches the cross-repository aggregate golden digest", () => {
    const publicIdentity = Object.freeze({
      format: "drawbackengine-schema9-producer-runtime" as const,
      version: 1 as const,
      algorithm: "sha256-engine-runtime-tree-v1" as const,
      runtime: RUNTIME,
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
    const aggregateSha256 = createHash("sha256")
      .update(canonicalSchema9RuntimeJson(publicIdentity))
      .digest("hex");
    expect(aggregateSha256).toBe(
      "8ae516a9c7dd38ec645f79036806fceb9f75e9e4860426d53b83befee5a0347d",
    );
    expect(() => {
      assertSchema9ProducerRuntimeIdentity({
        ...publicIdentity,
        aggregateSha256,
      });
    }).not.toThrow();
  });

  it("normalizes tracked CRLF metadata but detects semantic changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-lines-"));
    const lf = join(root, "lf");
    const crlf = join(root, "crlf");
    try {
      await createRuntimeFixture(lf, "\n");
      await createRuntimeFixture(crlf, "\r\n");
      const lfIdentity = await computeSchema9ProducerRuntimeIdentity(lf, RUNTIME);
      const crlfIdentity = await computeSchema9ProducerRuntimeIdentity(
        crlf,
        RUNTIME,
      );
      expect(crlfIdentity).toEqual(lfIdentity);

      await writeFile(
        join(crlf, "package.json"),
        '{"name":"fixture","packageManager":"pnpm@11.9.1"}\r\n',
        "utf8",
      );
      const changed = await computeSchema9ProducerRuntimeIdentity(crlf, RUNTIME);
      expect(changed.aggregateSha256).not.toBe(lfIdentity.aggregateSha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attests identical LF and CRLF source builds without masking semantic changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-build-lines-"));
    const executing = join(root, "executing");
    const rebuilt = join(root, "rebuilt");
    const scratch = join(root, "scratch");
    try {
      await createRuntimeFixture(executing, "\n");
      await createRuntimeFixture(rebuilt, "\n");
      await mkdir(scratch);
      const executingBuild = await compileRuntimeIdentityFixture(
        join(root, "executing-source"),
        "\r\n",
        1,
      );
      const rebuiltBuild = await compileRuntimeIdentityFixture(
        join(root, "rebuilt-source"),
        "\n",
        1,
      );
      expect(executingBuild.raw.includes(13)).toBe(true);
      expect(executingBuild.raw.equals(rebuiltBuild.raw)).toBe(false);
      const executingArtifact = executingBuild.normalized;
      const rebuiltArtifact = rebuiltBuild.normalized;
      expect(executingArtifact.equals(rebuiltArtifact)).toBe(true);
      expect(executingArtifact.includes(13)).toBe(false);
      await writeFile(
        join(executing, "apps", "engine-cli", "dist", "runtime-build.js"),
        executingArtifact,
        { flag: "wx" },
      );
      await writeFile(
        join(rebuilt, "apps", "engine-cli", "dist", "runtime-build.js"),
        rebuiltArtifact,
        { flag: "wx" },
      );

      await expect(attestSchema9ProducerRuntime(
        executing,
        COMMIT,
        undefined,
        {
          runtime: RUNTIME,
          temporaryParent: scratch,
          prepareSnapshot: async (_source, _commit, snapshot) => {
            await cp(rebuilt, snapshot, { recursive: true });
          },
        },
      )).resolves.toEqual(
        await computeSchema9ProducerRuntimeIdentity(rebuilt, RUNTIME),
      );

      const changedArtifact = (await compileRuntimeIdentityFixture(
        join(root, "changed-source"),
        "\n",
        2,
      )).normalized;
      expect(changedArtifact.equals(rebuiltArtifact)).toBe(false);
      await writeFile(
        join(executing, "apps", "engine-cli", "dist", "runtime-build.js"),
        changedArtifact,
      );
      await expect(attestSchema9ProducerRuntime(
        executing,
        COMMIT,
        undefined,
        {
          runtime: RUNTIME,
          temporaryParent: scratch,
          prepareSnapshot: async (_source, _commit, snapshot) => {
            await cp(rebuilt, snapshot, { recursive: true });
          },
        },
      )).rejects.toThrow("isolated clean rebuild");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects stale ignored dist against an isolated rebuilt snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-stale-"));
    const executing = join(root, "executing");
    const rebuilt = join(root, "rebuilt");
    const scratch = join(root, "scratch");
    try {
      await createRuntimeFixture(executing, "\n");
      await createRuntimeFixture(rebuilt, "\n");
      await mkdir(scratch);
      await writeFile(
        join(executing, "packages", "shared", "dist", "index.js"),
        "export const stale = true;\n",
        "utf8",
      );
      await expect(attestSchema9ProducerRuntime(
        executing,
        COMMIT,
        undefined,
        {
          runtime: RUNTIME,
          temporaryParent: scratch,
          prepareSnapshot: async (_source, _commit, snapshot) => {
            await cp(rebuilt, snapshot, { recursive: true });
          },
        },
      )).rejects.toThrow("isolated clean rebuild");
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds and requires the deferred parallel worker module", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-worker-"));
    try {
      await createRuntimeFixture(root, "\n");
      const before = await computeSchema9ProducerRuntimeIdentity(root, RUNTIME);
      const worker = join(
        root,
        "packages",
        "simulation-arena",
        "dist",
        "player-private-parallel-worker.js",
      );
      await writeFile(worker, "export const worker = 2;\n", "utf8");
      const after = await computeSchema9ProducerRuntimeIdentity(root, RUNTIME);
      expect(after.parallelWorker.sha256).not.toBe(
        before.parallelWorker.sha256,
      );
      await rm(worker);
      await expect(computeSchema9ProducerRuntimeIdentity(root, RUNTIME))
        .rejects.toThrow("missing required module");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds each workspace dependency resolution edge", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-binding-"));
    try {
      await createRuntimeFixture(root, "\n");
      const before = await computeSchema9ProducerRuntimeIdentity(root, RUNTIME);
      await writeFile(
        join(
          root,
          "apps",
          "engine-cli",
          "node_modules",
          "@drawbackengine",
          "shared",
          "dist",
          "index.js",
        ),
        "export const redirected = true;\n",
        "utf8",
      );
      const after = await computeSchema9ProducerRuntimeIdentity(root, RUNTIME);
      expect(after.coordinator.sha256).not.toBe(before.coordinator.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recursively binds and requires chessops runtime dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-transitive-"));
    const resultRoot = join(
      root,
      "packages",
      "chess-core",
      "node_modules",
      "chessops",
      "node_modules",
      "@badrap",
      "result",
    );
    try {
      await createRuntimeFixture(root, "\n");
      const before = await computeSchema9ProducerRuntimeIdentity(root, RUNTIME);
      await writeFile(
        join(resultRoot, "index.js"),
        "exports.changed = true;\n",
        "utf8",
      );
      const after = await computeSchema9ProducerRuntimeIdentity(root, RUNTIME);
      expect(after.coordinator.sha256).not.toBe(before.coordinator.sha256);
      expect(after.parallelWorker.sha256).not.toBe(
        before.parallelWorker.sha256,
      );

      await rm(resultRoot, { recursive: true, force: true });
      await expect(computeSchema9ProducerRuntimeIdentity(root, RUNTIME))
        .rejects.toThrow("@badrap/result could not be resolved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Node flags and module-path environment overrides", () => {
    expect(() => schema9RuntimeDescriptor({
      execArgv: ["--import", "unexpected.mjs"],
      environment: {},
    })).toThrow("execution arguments");
    for (const name of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "NODE_PRESERVE_SYMLINKS",
      "NODE_PRESERVE_SYMLINKS_MAIN",
    ]) {
      expect(() => schema9RuntimeDescriptor({
        execArgv: [],
        environment: { [name]: "injected" },
      })).toThrow(name);
    }
  });

  it("removes caller npm and pnpm configuration before rebuilding", () => {
    const environment = schema9SanitizedChildEnvironmentForTesting({
      PATH: "kept",
      npm_config_pnpmfile: "attacker.cjs",
      NPM_CONFIG_USERCONFIG: "attacker.npmrc",
      PnPm_CoNfIg_NoDe_LiNkEr: "hoisted",
      PNPM_HOME: "attacker-bin",
    });
    expect(environment["PATH"]).toBe("kept");
    expect(JSON.stringify(environment)).not.toContain("attacker");
    const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
    expect(environment).toMatchObject({
      NPM_CONFIG_USERCONFIG: nullConfig,
      NPM_CONFIG_GLOBALCONFIG: nullConfig,
      NPM_CONFIG_OFFLINE: "true",
      NPM_CONFIG_FROZEN_LOCKFILE: "true",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      PNPM_CONFIG_USERCONFIG: nullConfig,
      PNPM_CONFIG_GLOBALCONFIG: nullConfig,
      PNPM_CONFIG_OFFLINE: "true",
      PNPM_CONFIG_FROZEN_LOCKFILE: "true",
      PNPM_CONFIG_IGNORE_SCRIPTS: "true",
    });
  });

  it("proves a child pnpm lookup cannot read caller configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-pnpm-config-"));
    const cwd = join(root, "work");
    const injectedConfig = join(root, "injected-config");
    try {
      await mkdir(cwd);
      await writeFile(
        injectedConfig,
        "schema9-provenance-probe=attacker\n",
        "utf8",
      );
      const executable = process.platform === "win32"
        ? process.env["ComSpec"] ?? "C:\\Windows\\System32\\cmd.exe"
        : "pnpm";
      const arguments_ = process.platform === "win32"
        ? [
          "/d",
          "/s",
          "/c",
          "pnpm config get schema9-provenance-probe",
        ]
        : ["config", "get", "schema9-provenance-probe"];
      const output = await runSchema9RuntimeCommandForTesting(
        executable,
        arguments_,
        cwd,
        undefined,
        10_000,
        {
          ...process.env,
          npm_config_userconfig: injectedConfig,
          NPM_CONFIG_GLOBALCONFIG: injectedConfig,
          pnpm_config_global_pnpmfile: injectedConfig,
        },
      );
      expect(output).not.toContain("attacker");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back an interrupted isolated attestation", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-cancel-"));
    const executing = join(root, "executing");
    const scratch = join(root, "scratch");
    const controller = new AbortController();
    try {
      await createRuntimeFixture(executing, "\n");
      await mkdir(scratch);
      await expect(attestSchema9ProducerRuntime(
        executing,
        COMMIT,
        controller.signal,
        {
          runtime: RUNTIME,
          temporaryParent: scratch,
          prepareSnapshot: () => {
            controller.abort(new Error("injected attestation cancellation"));
            return Promise.reject(new Error(
              "injected attestation cancellation",
            ));
          },
        },
      )).rejects.toThrow("injected attestation cancellation");
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kills a real child tree on interruption and empties attestation scratch", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-tree-signal-"));
    const executing = join(root, "executing");
    const scratch = join(root, "scratch");
    const parentScript = join(root, "parent.mjs");
    const pidFile = join(root, "grandchild.pid");
    const controller = new AbortController();
    let grandchildPid: number | undefined;
    try {
      await createRuntimeFixture(executing, "\n");
      await mkdir(scratch);
      await writeProcessTreeScript(parentScript);
      const attestation = attestSchema9ProducerRuntime(
        executing,
        COMMIT,
        controller.signal,
        {
          runtime: RUNTIME,
          temporaryParent: scratch,
          prepareSnapshot: async (_source, _commit, _snapshot, signal) => {
            await runSchema9RuntimeCommandForTesting(
              process.execPath,
              [parentScript, pidFile],
              root,
              signal,
              30_000,
            );
          },
        },
      );
      grandchildPid = await waitForPidFile(pidFile);
      controller.abort(new Error("real process-tree interruption"));
      await expect(attestation).rejects.toThrow("real process-tree interruption");
      await expectProcessExit(grandchildPid);
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      controller.abort(new Error("test cleanup"));
      bestEffortKillProcess(grandchildPid);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("kills a real child tree after the bounded command timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-tree-timeout-"));
    const parentScript = join(root, "parent.mjs");
    const pidFile = join(root, "grandchild.pid");
    let grandchildPid: number | undefined;
    try {
      await writeProcessTreeScript(parentScript);
      await expect(runSchema9RuntimeCommandForTesting(
        process.execPath,
        [parentScript, pidFile],
        root,
        undefined,
        1_000,
      )).rejects.toThrow("time limit");
      grandchildPid = await waitForPidFile(pidFile);
      await expectProcessExit(grandchildPid);
    } finally {
      bestEffortKillProcess(grandchildPid);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(process.platform !== "win32")(
    "ignores a hostile SystemRoot when authenticating taskkill",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "schema9-taskkill-root-test-"));
      const parentScript = join(root, "parent.mjs");
      const pidFile = join(root, "grandchild.pid");
      let grandchildPid: number | undefined;
      try {
        await writeProcessTreeScript(parentScript);
        await runHostileSystemRootTaskkillVerification({
          root,
          parentScript,
          pidFile,
          hostileSystemRoot: join(root, "attacker-windows"),
        });
        grandchildPid = await waitForPidFile(pidFile);
        await expectProcessExit(grandchildPid);
      } finally {
        bestEffortKillProcess(grandchildPid);
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "keeps target runtime variables out of the authenticated supervisor",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "schema9-runtime-host-env-"));
      try {
        const output = await runSchema9RuntimeCommandForTesting(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            'process.stdout.write(JSON.stringify({ probe: process.env.SCHEMA9_TARGET_PROBE, coreclr: process.env.CORECLR_ENABLE_PROFILING, plus: process.env.COMPlus_ReadyToRun, modules: process.env.PSModulePath }));',
          ],
          root,
          undefined,
          10_000,
          {
            SCHEMA9_TARGET_PROBE: "target-visible",
            CORECLR_ENABLE_PROFILING: "0",
            COMPlus_ReadyToRun: "1",
            PSModulePath: join(root, "hostile-modules"),
          },
        );
        expect(JSON.parse(output)).toEqual({
          probe: "target-visible",
          coreclr: "0",
          plus: "1",
          modules: join(root, "hostile-modules"),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "rejects a null byte instead of truncating a bounded command argument",
    async () => {
      await expect(runSchema9RuntimeCommandForTesting(
        process.execPath,
        [`--version\0--must-not-be-truncated`],
        process.cwd(),
        undefined,
        10_000,
      )).rejects.toThrow("argument 0 contains a null byte");
    },
  );

  it(
    "rejects a null byte before authenticated Git command classification",
    async () => {
      await expect(runSchema9AuthenticatedGit(
        [`status\0--must-not-be-truncated`],
        process.cwd(),
      )).rejects.toThrow("contains a null byte");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "terminates an ignored-stdio fast-parent descendant before reporting success",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "schema9-runtime-fast-success-"));
      const parentScript = join(root, "fast-parent.mjs");
      const pidFile = join(root, "grandchild.pid");
      let grandchildPid: number | undefined;
      try {
        await writeFastParentProcessTreeScript(parentScript, "ignore");
        const command = runSchema9RuntimeCommandForTesting(
          process.execPath,
          [parentScript, pidFile],
          root,
          undefined,
          10_000,
        );
        grandchildPid = await waitForPidFile(pidFile);
        await expect(command).resolves.toBe("");
        expect(processIsAlive(grandchildPid)).toBe(false);
      } finally {
        bestEffortKillProcess(grandchildPid);
        if (grandchildPid !== undefined) {
          await expectProcessExit(grandchildPid);
        }
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      }
    },
    20_000,
  );

  it.skipIf(process.platform !== "win32")(
    "terminates an inherited-pipe fast-parent descendant before reporting success",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "schema9-runtime-fast-pipe-"));
      const parentScript = join(root, "fast-parent.mjs");
      const pidFile = join(root, "grandchild.pid");
      let grandchildPid: number | undefined;
      try {
        await writeFastParentProcessTreeScript(parentScript, "inherit");
        const command = runSchema9RuntimeCommandForTesting(
          process.execPath,
          [parentScript, pidFile],
          root,
          undefined,
          10_000,
        );
        grandchildPid = await waitForPidFile(pidFile);
        await expect(command).resolves.toBe("");
        expect(processIsAlive(grandchildPid)).toBe(false);
      } finally {
        bestEffortKillProcess(grandchildPid);
        if (grandchildPid !== undefined) {
          await expectProcessExit(grandchildPid);
        }
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      }
    },
    20_000,
  );

  it.skipIf(process.platform !== "win32")(
    "kills a detached descendant after timeout",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "schema9-runtime-fast-timeout-"));
      const parentScript = join(root, "fast-parent.mjs");
      const pidFile = join(root, "grandchild.pid");
      let grandchildPid: number | undefined;
      try {
        await writeFastParentProcessTreeScript(parentScript, "ignore", true);
        const command = runSchema9RuntimeCommandForTesting(
          process.execPath,
          [parentScript, pidFile],
          root,
          undefined,
          750,
        );
        grandchildPid = await waitForPidFile(pidFile);
        await expect(command).rejects.toThrow("time limit");
        await expectProcessExit(grandchildPid);
      } finally {
        bestEffortKillProcess(grandchildPid);
        if (grandchildPid !== undefined) {
          await expectProcessExit(grandchildPid);
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(process.platform !== "win32")(
    "kills an inherited-pipe descendant and empties scratch on cancellation",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "schema9-runtime-fast-cancel-"));
      const executing = join(root, "executing");
      const scratch = join(root, "scratch");
      const parentScript = join(root, "fast-parent.mjs");
      const pidFile = join(root, "grandchild.pid");
      const controller = new AbortController();
      let grandchildPid: number | undefined;
      try {
        await createRuntimeFixture(executing, "\n");
        await mkdir(scratch);
        await writeFastParentProcessTreeScript(parentScript, "inherit", true);
        const attestation = attestSchema9ProducerRuntime(
          executing,
          COMMIT,
          controller.signal,
          {
            runtime: RUNTIME,
            temporaryParent: scratch,
            prepareSnapshot: async (_source, _commit, _snapshot, signal) => {
              await runSchema9RuntimeCommandForTesting(
                process.execPath,
                [parentScript, pidFile],
                root,
                signal,
                30_000,
              );
            },
          },
        );
        grandchildPid = await waitForPidFile(pidFile);
        controller.abort(new Error("fast-parent attestation cancellation"));
        await expect(attestation).rejects.toThrow(
          "fast-parent attestation cancellation",
        );
        await expectProcessExit(grandchildPid);
        expect(await readdir(scratch)).toEqual([]);
      } finally {
        controller.abort(new Error("test cleanup"));
        bestEffortKillProcess(grandchildPid);
        if (grandchildPid !== undefined) {
          await expectProcessExit(grandchildPid);
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("settles after tree cleanup fails while a grandchild retains stdio", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-tree-failure-"));
    const parentScript = join(root, "parent.mjs");
    const pidFile = join(root, "grandchild.pid");
    const parentPidFile = join(root, "parent.pid");
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    let grandchildPid: number | undefined;
    let parentPid: number | undefined;
    process.on("unhandledRejection", captureUnhandled);
    try {
      await writeLeakingProcessTreeScript(parentScript);
      const command = runSchema9RuntimeCommandForTesting(
        process.execPath,
        [parentScript, pidFile, parentPidFile],
        root,
        undefined,
        500,
        process.env,
        () => Promise.reject(new Error("injected tree cleanup failure")),
        () => true,
      );
      const rejection = command.then(
        () => undefined,
        (error: unknown) => error,
      );
      grandchildPid = await waitForPidFile(pidFile);
      parentPid = await waitForPidFile(parentPidFile);
      const failure = await rejection;
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected timeout and cleanup failures to aggregate.");
      }
      expect(failure.message).toContain("tree cleanup failed");
      const failureMessages = (failure.errors as unknown as readonly unknown[])
        .map((error) => error instanceof Error ? error.message : String(error));
      expect(failureMessages).toEqual(expect.arrayContaining([
        expect.stringContaining("time limit"),
        "injected tree cleanup failure",
      ]));
      expect(processIsAlive(parentPid)).toBe(true);
      expect(processIsAlive(grandchildPid)).toBe(true);
      await new Promise<void>((accept) => setImmediate(accept));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", captureUnhandled);
      bestEffortKillProcess(grandchildPid);
      bestEffortKillProcess(parentPid);
      await Promise.all([
        ...(grandchildPid === undefined ? [] : [expectProcessExit(grandchildPid)]),
        ...(parentPid === undefined ? [] : [expectProcessExit(parentPid)]),
      ]);
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  }, 20_000);

  it("lets a wrapper exit after failed cleanup without wrapper-local cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-wrapper-exit-"));
    const parentScript = join(root, "parent.mjs");
    const wrapperScript = join(root, "wrapper.mjs");
    const pidFile = join(root, "grandchild.pid");
    const parentPidFile = join(root, "parent.pid");
    let grandchildPid: number | undefined;
    let parentPid: number | undefined;
    try {
      await writeLeakingProcessTreeScript(parentScript);
      await writeRuntimeWrapperScript(
        wrapperScript,
        join(
          process.cwd(),
          "apps",
          "engine-cli",
          "dist",
          "schema9-runtime-identity.js",
        ),
      );
      const output = await runSchema9RuntimeCommandForTesting(
        process.execPath,
        [wrapperScript, parentScript, pidFile, parentPidFile],
        root,
        undefined,
        5_000,
      );
      expect(output.trim()).toBe("wrapper-settled");
      grandchildPid = await waitForPidFile(pidFile);
      parentPid = await waitForPidFile(parentPidFile);
    } finally {
      bestEffortKillProcess(grandchildPid);
      bestEffortKillProcess(parentPid);
      await Promise.all([
        ...(grandchildPid === undefined ? [] : [expectProcessExit(grandchildPid)]),
        ...(parentPid === undefined ? [] : [expectProcessExit(parentPid)]),
      ]);
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    }
  }, 20_000);

  it("retains authenticated cleanup for a bounded retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-retry-"));
    const executing = join(root, "executing");
    const scratch = join(root, "scratch");
    let removals = 0;
    try {
      await createRuntimeFixture(executing, "\n");
      await mkdir(scratch);
      let failure: unknown;
      try {
        await attestSchema9ProducerRuntime(
          executing,
          COMMIT,
          undefined,
          {
            runtime: RUNTIME,
            temporaryParent: scratch,
            prepareSnapshot: async (_source, _commit, snapshot) => {
              await cp(executing, snapshot, { recursive: true });
            },
            removeOwnedDirectory: async (path, identity) => {
              removals += 1;
              if (removals === 1) {
                throw new Error("injected first cleanup failure");
              }
              await removeOwnedRuntimeDirectory(path, identity);
            },
          },
        );
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(IncompleteSameOwnerCleanupError);
      const owner = findRetainedCleanupOwner(failure);
      expect(owner).toBeInstanceOf(IncompleteSameOwnerCleanupError);
      await owner?.retryCleanup();
      expect(removals).toBe(2);
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not remove a replacement at an owned cleanup path", async () => {
    const root = await mkdtemp(join(tmpdir(), "schema9-runtime-owner-"));
    const owned = join(root, "owned");
    const sentinel = join(owned, "replacement.txt");
    try {
      await mkdir(owned);
      const identity = await ownedRuntimeDirectoryIdentity(owned);
      await rm(owned, { recursive: true, force: true });
      await mkdir(owned);
      await writeFile(sentinel, "replacement", "utf8");
      await expect(removeOwnedRuntimeDirectory(owned, identity))
        .rejects.toThrow("no longer the owned directory");
      expect(await readFile(sentinel, "utf8")).toBe("replacement");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compares the exact public identity rather than only the aggregate", () => {
    const identity = goldenIdentity();
    const forged = {
      ...identity,
      coordinator: {
        ...identity.coordinator,
        files: identity.coordinator.files + 1,
      },
    };
    expect(() => {
      assertSameSchema9ProducerRuntimeIdentity(forged, identity);
    }).toThrow();
  });
});

async function compileRuntimeIdentityFixture(
  projectRoot: string,
  lineEnding: "\n" | "\r\n",
  semanticValue: number,
): Promise<Readonly<{ raw: Buffer; normalized: Buffer }>> {
  const packageRoot = join(projectRoot, "apps", "runtime-fixture");
  const sourceRoot = join(packageRoot, "src");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    join(packageRoot, "tsconfig.json"),
    JSON.stringify({
      extends: join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "tsconfig.base.json",
      ),
      compilerOptions: {
        rootDir: "src",
        outDir: "dist",
        declaration: false,
        declarationMap: false,
        sourceMap: false,
      },
      include: ["src"],
    }),
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    join(sourceRoot, "runtime-build.ts"),
    [
      "// Runtime identity source checkout fixture.",
      `export const runtimeIdentityFixture = ${String(semanticValue)};`,
      "export const embeddedLineEnding = `first",
      "second`;",
      "",
    ].join(lineEnding),
    { encoding: "utf8", flag: "wx" },
  );
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [TYPESCRIPT_COMPILER, "-p", join(packageRoot, "tsconfig.json")],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(
          `TypeScript fixture compilation failed: ${stdout}${stderr}`,
          { cause: error },
        ));
      },
    );
  });
  const artifact = join(packageRoot, "dist", "runtime-build.js");
  const raw = await readFile(artifact);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [BUILD_ARTIFACT_NORMALIZER, projectRoot],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(
          `Build artifact normalization failed: ${stdout}${stderr}`,
          { cause: error },
        ));
      },
    );
  });
  return Object.freeze({ raw, normalized: await readFile(artifact) });
}

async function createRuntimeFixture(
  root: string,
  lineEnding: "\n" | "\r\n",
): Promise<void> {
  await writeText(
    join(root, "package.json"),
    { name: "fixture", packageManager: "pnpm@11.9.0" },
    lineEnding,
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'${lineEnding}`,
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    `packages:${lineEnding}  - packages/*${lineEnding}`,
    { encoding: "utf8", flag: "wx" },
  );
  for (const packagePath of WORKSPACE_PACKAGES) {
    const dependencies = packagePath === "apps/engine-cli"
      ? { "@drawbackengine/shared": "workspace:*" }
      : undefined;
    await writeText(
      join(root, ...packagePath.split("/"), "package.json"),
      {
        name: WORKSPACE_PACKAGE_NAMES[packagePath],
        version: "0.1.0",
        type: "module",
        ...(dependencies === undefined ? {} : { dependencies }),
      },
      lineEnding,
    );
    await writeFileCreatingParent(
      join(root, ...packagePath.split("/"), "dist", "index.js"),
      `export const id = ${JSON.stringify(packagePath)};\n`,
    );
  }
  await writeFileCreatingParent(
    join(
      root,
      "apps",
      "engine-cli",
      "dist",
      "schema9-player-private-cli.js",
    ),
    "export const coordinator = 1;\n",
  );
  await writeFileCreatingParent(
    join(
      root,
      "packages",
      "simulation-arena",
      "dist",
      "player-private-parallel-worker.js",
    ),
    "export const worker = 1;\n",
  );
  await writeText(
    join(
      root,
      "apps",
      "engine-cli",
      "node_modules",
      "@drawbackengine",
      "shared",
      "package.json",
    ),
    {
      name: "@drawbackengine/shared",
      version: "0.1.0",
      type: "module",
    },
    lineEnding,
  );
  await writeFileCreatingParent(
    join(
      root,
      "apps",
      "engine-cli",
      "node_modules",
      "@drawbackengine",
      "shared",
      "dist",
      "index.js",
    ),
    "export const id = '@drawbackengine/shared';\n",
  );
  for (const { consumer, packageName } of [
    { consumer: "packages/chess-core", packageName: "chess.js" },
    { consumer: "packages/chess-core", packageName: "chessops" },
    { consumer: "packages/chess-evaluator", packageName: "chess.js" },
    { consumer: "packages/drawback-engine", packageName: "chess.js" },
    { consumer: "packages/drawback-search", packageName: "chessops" },
  ] as const) {
    const packageRoot = join(
      root,
      ...consumer.split("/"),
      "node_modules",
      packageName,
    );
    await writeText(
      join(packageRoot, "package.json"),
      {
        name: packageName,
        version: "1.0.0",
        type: "module",
        ...(packageName === "chessops"
          ? { dependencies: { "@badrap/result": "1.0.0" } }
          : {}),
      },
      "\n",
    );
    await writeFileCreatingParent(
      join(packageRoot, "index.js"),
      `export const packageName = ${JSON.stringify(packageName)};\n`,
    );
    if (packageName === "chessops") {
      const resultRoot = join(
        packageRoot,
        "node_modules",
        "@badrap",
        "result",
      );
      await writeText(
        join(resultRoot, "package.json"),
        {
          name: "@badrap/result",
          version: "1.0.0",
          type: "commonjs",
        },
        "\n",
      );
      await writeFileCreatingParent(
        join(resultRoot, "index.js"),
        "exports.ok = true;\n",
      );
    }
  }
}

async function writeText(
  path: string,
  value: Readonly<Record<string, unknown>>,
  lineEnding: "\n" | "\r\n",
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(value, null, 2).replace(/\n/gu, lineEnding)}${lineEnding}`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function writeFileCreatingParent(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
}

function goldenIdentity(): Schema9ProducerRuntimeIdentity {
  const withoutAggregate = Object.freeze({
    format: "drawbackengine-schema9-producer-runtime" as const,
    version: 1 as const,
    algorithm: "sha256-engine-runtime-tree-v1" as const,
    runtime: RUNTIME,
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
  return Object.freeze({
    ...withoutAggregate,
    aggregateSha256: createHash("sha256")
      .update(canonicalSchema9RuntimeJson(withoutAggregate))
      .digest("hex"),
  });
}

async function writeProcessTreeScript(path: string): Promise<void> {
  await writeFile(
    path,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });',
      'if (child.pid === undefined) throw new Error("missing child pid");',
      'writeFileSync(process.argv[2], String(child.pid), "utf8");',
      'setInterval(() => undefined, 1000);',
      "",
    ].join("\n"),
    { encoding: "utf8", flag: "wx" },
  );
}

async function writeFastParentProcessTreeScript(
  path: string,
  stdio: "ignore" | "inherit",
  keepParentAlive = false,
): Promise<void> {
  const childProgram = "setInterval(() => undefined, 1000);";
  const childStdio = stdio === "ignore"
    ? '"ignore"'
    : '["ignore", "inherit", "inherit"]';
  await writeFile(
    path,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(childProgram)}], { detached: true, stdio: ${childStdio} });`,
      'if (child.pid === undefined) throw new Error("missing child pid");',
      'writeFileSync(process.argv[2], String(child.pid), "utf8");',
      "child.unref();",
      ...(keepParentAlive ? ["setInterval(() => undefined, 1000);"] : []),
      "",
    ].join("\n"),
    { encoding: "utf8", flag: "wx" },
  );
}

async function writeLeakingProcessTreeScript(path: string): Promise<void> {
  await writeFile(
    path,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(() => undefined, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });',
      'if (child.pid === undefined) throw new Error("missing child pid");',
      'writeFileSync(process.argv[2], String(child.pid), "utf8");',
      'writeFileSync(process.argv[3], String(process.pid), "utf8");',
      'setInterval(() => undefined, 1000);',
      "",
    ].join("\n"),
    { encoding: "utf8", flag: "wx" },
  );
}

async function writeRuntimeWrapperScript(
  path: string,
  runtimeModulePath: string,
): Promise<void> {
  await writeFile(
    path,
    [
      `import { runSchema9RuntimeCommandForTesting } from ${JSON.stringify(pathToFileURL(runtimeModulePath).href)};`,
      "const failure = await runSchema9RuntimeCommandForTesting(",
      "  process.execPath,",
      "  [process.argv[2], process.argv[3], process.argv[4]],",
      "  process.cwd(),",
      "  undefined,",
      "  400,",
      "  process.env,",
      '  () => Promise.reject(new Error("injected wrapper tree cleanup failure")),',
      "  () => true,",
      ").then(() => undefined, (error) => error);",
      'if (!(failure instanceof Error) || !failure.message.includes("tree cleanup failed")) {',
      '  throw new Error("wrapper did not preserve cleanup failure");',
      "}",
      'process.stdout.write("wrapper-settled\\n");',
      "",
    ].join("\n"),
    { encoding: "utf8", flag: "wx" },
  );
}

async function runHostileSystemRootTaskkillVerification(
  input: Readonly<{
    root: string;
    parentScript: string;
    pidFile: string;
    hostileSystemRoot: string;
  }>,
): Promise<void> {
  const runtimeModuleUrl = new URL(
    "./schema9-runtime-identity.ts",
    import.meta.url,
  ).href;
  const sourceLoader = new URL(
    "../node_modules/tsx/dist/loader.mjs",
    import.meta.url,
  ).href;
  const wrapper = String.raw`
const runtimeModuleUrl = process.argv[2];
const parentScript = process.argv[3];
const pidFile = process.argv[4];
const root = process.argv[5];
const hostileSystemRoot = process.argv[6];
const { runSchema9RuntimeCommandForTesting } = await import(runtimeModuleUrl);
const childEnvironment = { ...process.env };
process.env.SystemRoot = hostileSystemRoot;
const failure = await runSchema9RuntimeCommandForTesting(
  process.execPath,
  [parentScript, pidFile],
  root,
  undefined,
  1_000,
  childEnvironment,
).then(() => undefined, (error) => error);
if (!(failure instanceof Error) || !failure.message.includes("time limit")) {
  throw new Error("isolated hostile-SystemRoot command did not time out");
}
process.stdout.write("taskkill-authenticated\n");
`;
  const output = await runSchema9RuntimeCommandForTesting(
    process.execPath,
    [
      "--import",
      sourceLoader,
      "--input-type=module",
      "--eval",
      wrapper,
      "schema9-hostile-system-root-wrapper",
      runtimeModuleUrl,
      input.parentScript,
      input.pidFile,
      input.root,
      input.hostileSystemRoot,
    ],
    input.root,
    undefined,
    15_000,
  );
  if (output.trim() !== "taskkill-authenticated") {
    throw new Error("Isolated hostile-SystemRoot verification was incomplete.");
  }
}

async function waitForPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const value = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isSafeInteger(value) && value > 0) {
        return value;
      }
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    await new Promise((accept) => setTimeout(accept, 20));
  }
  throw new Error("Timed out waiting for the real grandchild PID.");
}

async function expectProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return;
    }
    await new Promise((accept) => setTimeout(accept, 20));
  }
  throw new Error(`Grandchild process ${String(pid)} remained alive.`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
}

function bestEffortKillProcess(pid: number | undefined): void {
  if (pid === undefined || !processIsAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error: unknown) {
    if (!isNodeError(error, "ESRCH")) {
      throw error;
    }
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
