import { Buffer } from "node:buffer";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { resolveOwnedWorkspacePackage } from "./clean-owned-build-output.mjs";

const WORKSPACE_ROOTS = Object.freeze(["apps", "packages"]);
// Keep this allowlist tied to text formats actually emitted into workspace
// dist directories. Extension gating is deliberate: arbitrary bytes must
// never be decoded and rewritten merely because they happen to contain CRLF.
const GENERATED_TEXT_PATTERN =
  /(?:\.(?:[cm]?js|json|map|css|html|svg)|\.d\.[cm]?ts)$/u;

export async function normalizeBuiltArtifacts(repository, options = {}) {
  const canonicalRepository = resolve(repository);
  const artifacts = [];
  if (options.packageRoot === undefined) {
    for (const workspaceRoot of WORKSPACE_ROOTS) {
      const workspacePath = join(canonicalRepository, workspaceRoot);
      for (const entry of await readDirectoryIfPresent(workspacePath)) {
        if (!entry.isDirectory()) {
          continue;
        }
        await collectGeneratedTextArtifacts(
          join(workspacePath, entry.name, "dist"),
          artifacts,
        );
      }
    }
  } else {
    const packageRoot = await resolveOwnedWorkspacePackage(
      canonicalRepository,
      options.packageRoot,
    );
    await collectGeneratedTextArtifacts(join(packageRoot, "dist"), artifacts);
  }
  artifacts.sort((left, right) => left.localeCompare(right, "en"));

  let changedFiles = 0;
  for (const artifact of artifacts) {
    const bytes = await readFile(artifact);
    const canonicalizeHtmlEnding = artifact.endsWith(".html");
    if (!bytes.includes(13) && !canonicalizeHtmlEnding) {
      continue;
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      throw new Error(`Generated text artifact is not valid UTF-8: ${artifact}`);
    }
    let canonical = text.replace(/\r\n?/gu, "\n");
    // Vite preserves a source line-ending-dependent extra blank line at the
    // end of generated HTML. Collapse only that generated HTML suffix so LF
    // and CRLF checkouts emit identical bytes without rewriting JavaScript or
    // CSS content beyond newline normalization.
    if (canonicalizeHtmlEnding) {
      canonical = canonical.replace(/\n{2,}$/u, "\n");
    }
    if (canonical === text) {
      continue;
    }
    await writeFile(artifact, canonical, "utf8");
    changedFiles += 1;
  }
  return Object.freeze({ files: artifacts.length, changedFiles });
}

async function collectGeneratedTextArtifacts(directory, artifacts) {
  const directoryStatus = await lstatIfPresent(directory);
  if (directoryStatus === undefined) {
    return;
  }
  if (directoryStatus.isSymbolicLink()) {
    throw new Error(
      `Refusing to normalize a symbolic build-output directory: ${directory}`,
    );
  }
  if (!directoryStatus.isDirectory()) {
    throw new Error(`Build-output path is not a directory: ${directory}`);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Refusing to normalize through a symbolic build-output entry: ${path}`,
      );
    } else if (entry.isDirectory()) {
      await collectGeneratedTextArtifacts(path, artifacts);
    } else if (entry.isFile() && GENERATED_TEXT_PATTERN.test(entry.name)) {
      artifacts.push(path);
    }
  }
}

async function readDirectoryIfPresent(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined
  && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))
) {
  const ownRepository = fileURLToPath(new URL("..", import.meta.url));
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 0) {
    await normalizeBuiltArtifacts(ownRepository);
  } else if (arguments_.length === 1 && arguments_[0] === "--package") {
    await normalizeBuiltArtifacts(ownRepository, { packageRoot: process.cwd() });
  } else if (
    arguments_.length === 2
    && arguments_[0] === "--repository"
    && arguments_[1] !== undefined
  ) {
    await normalizeBuiltArtifacts(arguments_[1]);
  } else {
    throw new Error(
      "Usage: normalize-built-artifacts.mjs [--package | --repository <path>]",
    );
  }
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
