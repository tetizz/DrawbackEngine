import { Buffer } from "node:buffer";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOTS = Object.freeze(["apps", "packages"]);
const GENERATED_TEXT_PATTERN = /(?:\.(?:[cm]?js|json|map)|\.d\.[cm]?ts)$/u;

export async function normalizeBuiltArtifacts(repository) {
  const canonicalRepository = resolve(repository);
  const artifacts = [];
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
  artifacts.sort((left, right) => left.localeCompare(right, "en"));

  let changedFiles = 0;
  for (const artifact of artifacts) {
    const bytes = await readFile(artifact);
    if (!bytes.includes(13)) {
      continue;
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      throw new Error(`Generated text artifact is not valid UTF-8: ${artifact}`);
    }
    const canonical = text.replace(/\r\n?/gu, "\n");
    await writeFile(artifact, canonical, "utf8");
    changedFiles += 1;
  }
  return Object.freeze({ files: artifacts.length, changedFiles });
}

async function collectGeneratedTextArtifacts(directory, artifacts) {
  for (const entry of await readDirectoryIfPresent(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
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
  const repository = process.argv[2] ?? process.cwd();
  await normalizeBuiltArtifacts(repository);
}
