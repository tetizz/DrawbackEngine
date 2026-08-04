import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeBuiltArtifacts } from "./normalize-built-artifacts.mjs";

describe("built artifact line endings", () => {
  it("canonicalizes generated text without changing semantics or other files", async () => {
    const repository = await mkdtemp(join(tmpdir(), "built-artifact-lines-"));
    const dist = join(repository, "apps", "fixture", "dist");
    const source = join(repository, "apps", "fixture", "src");
    const generated = join(dist, "runtime.js");
    const sourceFile = join(source, "runtime.ts");
    const binary = join(dist, "runtime.bin");
    try {
      await mkdir(dist, { recursive: true });
      await mkdir(source, { recursive: true });
      await writeFile(generated, "export const value = `first\r\nsecond`;\r\n", "utf8");
      await writeFile(sourceFile, "export const source = true;\r\n", "utf8");
      await writeFile(binary, Buffer.from([0, 13, 10, 255]));

      const first = await normalizeBuiltArtifacts(repository);
      expect(first).toEqual({ files: 1, changedFiles: 1 });
      const canonical = await readFile(generated);
      expect(canonical.toString("utf8")).toBe(
        "export const value = `first\nsecond`;\n",
      );
      expect(createHash("sha256").update(canonical).digest("hex")).toBe(
        createHash("sha256")
          .update("export const value = `first\nsecond`;\n")
          .digest("hex"),
      );
      expect(await readFile(sourceFile, "utf8")).toContain("\r\n");
      expect(await readFile(binary)).toEqual(Buffer.from([0, 13, 10, 255]));

      const second = await normalizeBuiltArtifacts(repository);
      expect(second).toEqual({ files: 1, changedFiles: 0 });
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});
