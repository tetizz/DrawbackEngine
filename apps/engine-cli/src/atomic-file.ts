import { randomUUID } from "node:crypto";
import { link, rm, writeFile } from "node:fs/promises";

async function removeWithoutMasking(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

async function publishNoClobber(
  temporaryPath: string,
  path: string,
): Promise<void> {
  await link(temporaryPath, path);
  try {
    await rm(temporaryPath);
  } catch (error: unknown) {
    await removeWithoutMasking(path);
    throw error;
  }
}

export async function writeUtf8FileAtomicNoClobber(
  path: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
    });
    await publishNoClobber(temporaryPath, path);
  } catch (error: unknown) {
    await removeWithoutMasking(temporaryPath);
    throw error;
  }
}
