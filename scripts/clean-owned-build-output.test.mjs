import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanOwnedBuildOutput } from "./clean-owned-build-output.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_PREBUILD = "node ../../scripts/clean-owned-build-output.mjs";
const PACKAGE_POSTBUILD =
  "node ../../scripts/normalize-built-artifacts.mjs --package";

describe("owned workspace build cleanup", () => {
  it("removes stale deleted-source outputs without widening past package dist", async () => {
    const repository = await mkdtemp(join(tmpdir(), "owned-dist-cleanup-"));
    const packageRoot = join(repository, "apps", "fixture");
    const staleOutput = join(packageRoot, "dist", "deleted-source.js");
    const source = join(packageRoot, "src", "current-source.ts");
    const siblingOutput = join(
      repository,
      "packages",
      "sibling",
      "dist",
      "keep.js",
    );
    const repositoryOutput = join(repository, "dist", "keep.js");
    try {
      await writeFixturePackage(packageRoot, "@fixture/owned");
      await writeFixturePackage(dirname(dirname(siblingOutput)), "@fixture/sibling");
      await mkdir(dirname(staleOutput), { recursive: true });
      await mkdir(dirname(source), { recursive: true });
      await mkdir(dirname(siblingOutput), { recursive: true });
      await mkdir(dirname(repositoryOutput), { recursive: true });
      await writeFile(staleOutput, "export const deleted = true;\n", "utf8");
      await writeFile(source, "export const current = true;\n", "utf8");
      await writeFile(siblingOutput, "export const sibling = true;\n", "utf8");
      await writeFile(repositoryOutput, "export const root = true;\n", "utf8");

      const first = await cleanOwnedBuildOutput(repository, packageRoot);
      expect(first.removed).toBe(true);
      await expect(access(staleOutput)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(source, "utf8")).toContain("current = true");
      expect(await readFile(siblingOutput, "utf8")).toContain("sibling = true");
      expect(await readFile(repositoryOutput, "utf8")).toContain("root = true");

      const second = await cleanOwnedBuildOutput(repository, packageRoot);
      expect(second.removed).toBe(false);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("rejects repository-wide and external cleanup targets", async () => {
    const repository = await mkdtemp(join(tmpdir(), "owned-dist-boundary-"));
    const external = await mkdtemp(join(tmpdir(), "external-dist-boundary-"));
    try {
      await writeFile(
        join(repository, "package.json"),
        '{"name":"fixture-root"}\n',
        "utf8",
      );
      await writeFile(
        join(external, "package.json"),
        '{"name":"fixture-external"}\n',
        "utf8",
      );
      await expect(cleanOwnedBuildOutput(repository, repository)).rejects.toThrow(
        "outside a direct apps/* or packages/* workspace",
      );
      await expect(cleanOwnedBuildOutput(repository, external)).rejects.toThrow(
        "outside a direct apps/* or packages/* workspace",
      );
    } finally {
      await Promise.all([
        rm(repository, { recursive: true, force: true }),
        rm(external, { recursive: true, force: true }),
      ]);
    }
  });

  it("unlinks a symbolic dist directory without deleting its target", async () => {
    const repository = await mkdtemp(join(tmpdir(), "owned-dist-symlink-"));
    const external = await mkdtemp(join(tmpdir(), "external-dist-target-"));
    const packageRoot = join(repository, "apps", "fixture");
    const output = join(packageRoot, "dist");
    const externalSentinel = join(external, "keep.js");
    try {
      await writeFixturePackage(packageRoot, "@fixture/symbolic-dist");
      await writeFile(
        externalSentinel,
        "export const external = true;\n",
        "utf8",
      );
      await symlink(external, output, "junction");

      const result = await cleanOwnedBuildOutput(repository, packageRoot);
      expect(result.removed).toBe(true);
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(externalSentinel, "utf8")).toContain(
        "external = true",
      );
    } finally {
      await Promise.all([
        rm(repository, { recursive: true, force: true }),
        rm(external, { recursive: true, force: true }),
      ]);
    }
  });

  it("wires every emitting workspace package through the guarded prebuild", async () => {
    const packageRoots = [];
    for (const container of ["apps", "packages"]) {
      const containerPath = join(repositoryRoot, container);
      for (const entry of await readdir(containerPath, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          packageRoots.push(join(containerPath, entry.name));
        }
      }
    }

    const emittingPackages = [];
    for (const packageRoot of packageRoots) {
      const manifest = JSON.parse(
        await readFile(join(packageRoot, "package.json"), "utf8"),
      );
      if (manifest.scripts?.build !== undefined) {
        emittingPackages.push(manifest.name);
        expect(manifest.scripts.prebuild, manifest.name).toBe(PACKAGE_PREBUILD);
        expect(manifest.scripts.postbuild, manifest.name).toBe(PACKAGE_POSTBUILD);
      }
    }
    expect(emittingPackages.length).toBeGreaterThan(0);

    const rootManifest = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    );
    expect(rootManifest.scripts.build).toContain("pnpm -r --if-present build");
    expect(rootManifest.scripts.build).toContain(
      "node scripts/normalize-built-artifacts.mjs",
    );
  });
});

async function writeFixturePackage(packageRoot, name) {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name })}\n`,
    "utf8",
  );
}
