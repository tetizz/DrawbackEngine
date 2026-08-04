import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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
    const html = join(dist, "index.html");
    const svg = join(dist, "favicon.svg");
    const sourceFile = join(source, "runtime.ts");
    const binary = join(dist, "runtime.bin");
    try {
      await mkdir(dist, { recursive: true });
      await mkdir(source, { recursive: true });
      await writeFile(generated, "export const value = `first\r\nsecond`;\r\n", "utf8");
      await writeFile(html, "<!doctype html>\r\n<title>Fixture</title>\r\n", "utf8");
      await writeFile(
        svg,
        '<svg xmlns="http://www.w3.org/2000/svg">\r\n<path d="M0 0"/>\r\n</svg>\r\n',
        "utf8",
      );
      await writeFile(sourceFile, "export const source = true;\r\n", "utf8");
      await writeFile(binary, Buffer.from([0, 13, 10, 255]));

      const first = await normalizeBuiltArtifacts(repository);
      expect(first).toEqual({ files: 3, changedFiles: 3 });
      const canonical = await readFile(generated);
      expect(canonical.toString("utf8")).toBe(
        "export const value = `first\nsecond`;\n",
      );
      expect(createHash("sha256").update(canonical).digest("hex")).toBe(
        createHash("sha256")
          .update("export const value = `first\nsecond`;\n")
          .digest("hex"),
      );
      expect(await readFile(html, "utf8")).toBe(
        "<!doctype html>\n<title>Fixture</title>\n",
      );
      expect(await readFile(svg, "utf8")).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg">\n<path d="M0 0"/>\n</svg>\n',
      );
      expect(await readFile(sourceFile, "utf8")).toContain("\r\n");
      expect(await readFile(binary)).toEqual(Buffer.from([0, 13, 10, 255]));

      const second = await normalizeBuiltArtifacts(repository);
      expect(second).toEqual({ files: 3, changedFiles: 0 });
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("makes LF and CRLF emitted text byte-identical", async () => {
    const repository = await mkdtemp(join(tmpdir(), "built-artifact-replay-"));
    const lfDist = join(repository, "apps", "lf-fixture", "dist");
    const crlfDist = join(repository, "apps", "crlf-fixture", "dist");
    const fixtureFiles = new Map([
      ["index.html", "<!doctype html>\n<title>Replay</title>\n"],
      [
        "favicon.svg",
        '<svg xmlns="http://www.w3.org/2000/svg">\n<circle cx="8" cy="8" r="7"/>\n</svg>\n',
      ],
      ["assets/app.css", ":root {\n  color: black;\n}\n"],
      ["assets/app.js", "export const replay = true;\n"],
    ]);
    try {
      for (const [path, content] of fixtureFiles) {
        await mkdir(join(lfDist, "assets"), { recursive: true });
        await mkdir(join(crlfDist, "assets"), { recursive: true });
        await writeFile(join(lfDist, path), content, "utf8");
        await writeFile(
          join(crlfDist, path),
          content.replaceAll("\n", "\r\n"),
          "utf8",
        );
      }

      await normalizeBuiltArtifacts(repository);
      for (const path of fixtureFiles.keys()) {
        const [lf, crlf] = await Promise.all([
          readFile(join(lfDist, path)),
          readFile(join(crlfDist, path)),
        ]);
        expect(crlf).toEqual(lf);
      }
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("normalizes only the requested package for direct package builds", async () => {
    const repository = await mkdtemp(join(tmpdir(), "owned-artifact-lines-"));
    const selectedPackage = join(repository, "apps", "selected");
    const siblingPackage = join(repository, "apps", "sibling");
    const selectedHtml = join(selectedPackage, "dist", "index.html");
    const siblingHtml = join(siblingPackage, "dist", "index.html");
    try {
      for (const [packageRoot, name] of [
        [selectedPackage, "@fixture/selected"],
        [siblingPackage, "@fixture/sibling"],
      ]) {
        await mkdir(join(packageRoot, "dist"), { recursive: true });
        await writeFile(
          join(packageRoot, "package.json"),
          `${JSON.stringify({ name })}\n`,
          "utf8",
        );
        await writeFile(
          join(packageRoot, "dist", "index.html"),
          "<!doctype html>\r\n<title>Owned</title>\r\n",
          "utf8",
        );
      }

      const result = await normalizeBuiltArtifacts(repository, {
        packageRoot: selectedPackage,
      });
      expect(result).toEqual({ files: 1, changedFiles: 1 });
      expect(await readFile(selectedHtml, "utf8")).not.toContain("\r");
      expect(await readFile(siblingHtml, "utf8")).toContain("\r\n");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("rejects symbolic dist roots and nested entries without external writes", async () => {
    const repository = await mkdtemp(join(tmpdir(), "artifact-symlink-boundary-"));
    const packageRoot = join(repository, "apps", "fixture");
    const dist = join(packageRoot, "dist");
    const external = join(repository, "external-output");
    const externalHtml = join(external, "index.html");
    try {
      await mkdir(packageRoot, { recursive: true });
      await mkdir(external, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        '{"name":"@fixture/symlink-boundary"}\n',
        "utf8",
      );
      await writeFile(
        externalHtml,
        "<!doctype html>\r\n<title>External</title>\r\n",
        "utf8",
      );

      await symlink(external, dist, "junction");
      await expect(
        normalizeBuiltArtifacts(repository, { packageRoot }),
      ).rejects.toThrow("symbolic build-output directory");
      expect(await readFile(externalHtml, "utf8")).toContain("\r\n");

      await unlink(dist);
      await mkdir(dist, { recursive: true });
      await symlink(external, join(dist, "linked"), "junction");
      await expect(
        normalizeBuiltArtifacts(repository, { packageRoot }),
      ).rejects.toThrow("symbolic build-output entry");
      expect(await readFile(externalHtml, "utf8")).toContain("\r\n");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});
