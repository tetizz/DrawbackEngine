import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeBuiltArtifacts } from "./normalize-built-artifacts.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const playWebRoot = join(repositoryRoot, "apps", "play-web");
const requireFromPlayWeb = createRequire(
  pathToFileURL(join(playWebRoot, "package.json")),
);
const { build: buildWithVite } = await import(
  pathToFileURL(requireFromPlayWeb.resolve("vite")).href
);
const { default: playWebViteConfig } = await import(
  pathToFileURL(join(playWebRoot, "vite.config.mjs")).href
);

describe("play-web Vite artifact cleanup", () => {
  it("removes stale client hashes without deleting the sibling server build", async () => {
    expect(playWebViteConfig.build?.emptyOutDir).toBe(true);

    const fixture = await mkdtemp(join(tmpdir(), "play-web-vite-cleanup-"));
    const clientSource = join(fixture, "src", "client");
    const clientOutput = join(fixture, "dist", "client");
    const serverSentinel = join(fixture, "dist", "server", "entry.js");
    const entry = join(clientSource, "main.js");
    try {
      await mkdir(clientSource, { recursive: true });
      await mkdir(dirname(serverSentinel), { recursive: true });
      await writeFile(
        join(clientSource, "index.html"),
        '<div id="app"></div><script type="module" src="/main.js"></script>',
        "utf8",
      );
      await writeFile(serverSentinel, "export const server = true;\n", "utf8");

      await writeFile(entry, 'document.body.dataset.version = "first";\n', "utf8");
      await buildFixture(clientSource, clientOutput);
      const firstAsset = await soleJavaScriptAsset(clientOutput);

      await writeFile(entry, 'document.body.dataset.version = "second";\n', "utf8");
      await buildFixture(clientSource, clientOutput);
      const secondAsset = await soleJavaScriptAsset(clientOutput);

      expect(secondAsset).not.toBe(firstAsset);
      expect(await readdir(join(clientOutput, "assets"))).not.toContain(firstAsset);
      await expect(access(join(clientOutput, "assets", firstAsset))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(serverSentinel, "utf8")).toBe(
        "export const server = true;\n",
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("produces the same normalized Vite tree from LF and CRLF sources", async () => {
    const repository = await mkdtemp(join(tmpdir(), "vite-line-replay-"));
    const lfRoot = join(repository, "apps", "lf-build", "client");
    const crlfRoot = join(repository, "apps", "crlf-build", "client");
    const lfOutput = join(repository, "apps", "lf-build", "dist");
    const crlfOutput = join(repository, "apps", "crlf-build", "dist");
    try {
      await writeLineEndingFixture(lfRoot, "\n");
      await writeLineEndingFixture(crlfRoot, "\r\n");
      await Promise.all([
        buildFixture(lfRoot, lfOutput),
        buildFixture(crlfRoot, crlfOutput),
      ]);
      await normalizeBuiltArtifacts(repository);

      expect(await artifactTree(crlfOutput)).toEqual(
        await artifactTree(lfOutput),
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

async function buildFixture(root, outDir) {
  await buildWithVite({
    configFile: false,
    root,
    logLevel: "silent",
    build: {
      outDir,
      emptyOutDir: playWebViteConfig.build.emptyOutDir,
    },
  });
}

async function soleJavaScriptAsset(clientOutput) {
  const assets = (await readdir(join(clientOutput, "assets"))).filter((name) =>
    name.endsWith(".js")
  );
  expect(assets).toHaveLength(1);
  return assets[0];
}

async function writeLineEndingFixture(root, eol) {
  await mkdir(join(root, "public"), { recursive: true });
  const withEnding = (value) => value.replaceAll("\n", eol);
  await Promise.all([
    writeFile(
      join(root, "index.html"),
      withEnding(
        '<!doctype html>\n<link rel="icon" href="/favicon.svg">\n<div id="app"></div>\n<script type="module" src="/main.js"></script>\n',
      ),
      "utf8",
    ),
    writeFile(
      join(root, "main.js"),
      withEnding('import "./style.css";\ndocument.body.dataset.ready = "true";\n'),
      "utf8",
    ),
    writeFile(
      join(root, "style.css"),
      withEnding(":root {\n  color: black;\n}\n"),
      "utf8",
    ),
    writeFile(
      join(root, "public", "favicon.svg"),
      withEnding(
        '<svg xmlns="http://www.w3.org/2000/svg">\n<circle cx="8" cy="8" r="7"/>\n</svg>\n',
      ),
      "utf8",
    ),
  ]);
}

async function artifactTree(root) {
  const files = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collect(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  await collect(root);
  files.sort((left, right) => left.localeCompare(right, "en"));
  return await Promise.all(
    files.map(async (path) =>
      Object.freeze({
        path: relative(root, path).replaceAll("\\", "/"),
        bytes: (await readFile(path)).toString("hex"),
      })
    ),
  );
}
