import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { describe, expect, it } from "vitest";

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
