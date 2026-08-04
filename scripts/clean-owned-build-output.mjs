import { lstat, readFile, realpath, rm, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const WORKSPACE_ROOTS = new Set(["apps", "packages"]);

/**
 * Remove only the dist directory directly owned by a workspace package.
 *
 * Both paths are canonicalized before the ownership check. This keeps a
 * package-local prebuild from widening into a repository or external-path
 * deletion if it is invoked from the wrong directory.
 */
export async function cleanOwnedBuildOutput(repository, packageRoot) {
  const canonicalPackageRoot = await resolveOwnedWorkspacePackage(
    repository,
    packageRoot,
  );
  const output = join(canonicalPackageRoot, "dist");
  const status = await lstatIfPresent(output);
  if (status === undefined) {
    return Object.freeze({ output, removed: false });
  }
  if (status.isSymbolicLink()) {
    await unlink(output);
  } else {
    await rm(output, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
  return Object.freeze({ output, removed: true });
}

export async function resolveOwnedWorkspacePackage(repository, packageRoot) {
  const canonicalRepository = await realpath(resolve(repository));
  const canonicalPackageRoot = await realpath(resolve(packageRoot));
  const packageRelativePath = relative(
    canonicalRepository,
    canonicalPackageRoot,
  );
  const segments = packageRelativePath.split(sep);
  if (
    segments.length !== 2
    || !WORKSPACE_ROOTS.has(segments[0])
    || segments[1].length === 0
  ) {
    throw new Error(
      `Refusing to clean build output outside a direct apps/* or packages/* workspace: ${canonicalPackageRoot}`,
    );
  }

  const manifestPath = join(canonicalPackageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest === null
    || typeof manifest !== "object"
    || !("name" in manifest)
    || typeof manifest.name !== "string"
    || manifest.name.length === 0
  ) {
    throw new Error(`Workspace manifest has no package name: ${manifestPath}`);
  }
  return canonicalPackageRoot;
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined
  && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))
) {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  await cleanOwnedBuildOutput(repository, process.cwd());
}
