/* global process */
import {
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_CATEGORIES,
  generateEvidenceMatrix,
  validateCapturableKingCatalog,
  validateEvidenceMatrix,
} from "./validate-rule-verification-evidence.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function item(disposition = "waived", references = []) {
  return {
    disposition,
    references,
    rationale: `${disposition} in validator test.`,
  };
}

function evidenceWith(overrides = {}) {
  return Object.fromEntries(EVIDENCE_CATEGORIES.map((category) => [
    category,
    overrides[category] ?? item(),
  ]));
}

function matrixEntry(status, evidence) {
  return {
    ruleId: "alpha",
    implementationStatus: status,
    evidence,
  };
}

function matrix(status, evidence) {
  return {
    schemaVersion: 2,
    policy: "test",
    entries: [matrixEntry(status, evidence)],
  };
}

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "drawback-evidence-"));
  await mkdir(join(root, "docs", "rules"), { recursive: true });
  await mkdir(join(root, "packages", "engine", "src"), { recursive: true });
  await mkdir(join(root, "data", "fixtures"), { recursive: true });

  const markdown = EVIDENCE_CATEGORIES.map(
    (category) => `<!-- drawback-evidence:alpha:${category} -->`,
  ).join("\n");
  await writeFile(join(root, "docs", "rules", "alpha.md"), markdown);

  const testLines = EVIDENCE_CATEGORIES
    .filter((category) =>
      category !== "specification" && category !== "replay")
    .flatMap((category) => [
      `// drawback-evidence:alpha:${category}`,
      `it("${category} alpha case", () => {});`,
    ]);
  testLines.push(
    "// drawback-evidence:alpha:replay",
    "// data/fixtures/alpha.json",
    'it("replays alpha fixture", () => {});',
    'it.skip("skipped alpha case", () => {});',
  );
  await writeFile(
    join(root, "packages", "engine", "src", "alpha.test.ts"),
    `import { it } from "vitest";\n${testLines.join("\n")}\n`,
  );
  await writeFile(
    join(root, "data", "fixtures", "alpha.json"),
    JSON.stringify({ ruleId: "alpha", moves: ["e2e4"] }),
  );
  return root;
}

function specification(category = "specification") {
  return {
    kind: "specification",
    path: "docs/rules/alpha.md",
    anchor: `drawback-evidence:alpha:${category}`,
  };
}

function vitestReference(category) {
  return {
    kind: "vitest",
    path: "packages/engine/src/alpha.test.ts",
    testName: `${category} alpha case`,
    anchor: `drawback-evidence:alpha:${category}`,
  };
}

function replayReference() {
  return {
    kind: "replay",
    fixturePath: "data/fixtures/alpha.json",
    anchor: "drawback-evidence:alpha:replay",
    runner: {
      path: "packages/engine/src/alpha.test.ts",
      testName: "replays alpha fixture",
    },
  };
}

function completeVerifiedEvidence() {
  return evidenceWith({
    specification: item("evidenced", [specification()]),
    positive: item("evidenced", [vitestReference("positive")]),
    negative: item("evidenced", [vitestReference("negative")]),
    edge: item("evidenced", [vitestReference("edge")]),
    promotion: item("evidenced", [vitestReference("promotion")]),
    castling: item("not-applicable", [specification("castling")]),
    enPassant: item("not-applicable", [specification("enPassant")]),
    startOfTurnLoss: item(
      "not-applicable",
      [specification("startOfTurnLoss")],
    ),
    replay: item("evidenced", [replayReference()]),
  });
}

describe("rule verification evidence gate", () => {
  it("validates the v3 capturable-king fragment against live registry evidence", async () => {
    const canonical = JSON.parse(
      await readFile(
        join(REPOSITORY_ROOT, "data", "catalog", "observed-drawbacks.json"),
        "utf8",
      ),
    );
    const capturable = JSON.parse(
      await readFile(
        join(
          REPOSITORY_ROOT,
          "data",
          "catalog",
          "capturable-king-drawbacks-v3.json",
        ),
        "utf8",
      ),
    );

    await expect(
      validateCapturableKingCatalog(canonical, capturable, {
        repositoryRoot: REPOSITORY_ROOT,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects v3 authority drift and changes to the frozen 194/182 boundary", async () => {
    const canonical = JSON.parse(
      await readFile(
        join(REPOSITORY_ROOT, "data", "catalog", "observed-drawbacks.json"),
        "utf8",
      ),
    );
    const capturable = JSON.parse(
      await readFile(
        join(
          REPOSITORY_ROOT,
          "data",
          "catalog",
          "capturable-king-drawbacks-v3.json",
        ),
        "utf8",
      ),
    );
    canonical.counts.executable = 183;
    capturable.rules[0].authorityId = "standard-chess/v1";

    const errors = await validateCapturableKingCatalog(
      canonical,
      capturable,
      { checkFiles: false },
    );
    expect(errors).toContain(
      "Frozen observed catalog must retain 194 observed, 182 executable, and 12 unsupported rules.",
    );
    expect(errors).toContain(
      "Capturable-king rule femme-fatale has invalid authority, status, or descriptive data.",
    );
  });

  it("requires frozen Irresistible to remain partial while v3 completes its authority", async () => {
    const canonical = JSON.parse(
      await readFile(
        join(REPOSITORY_ROOT, "data", "catalog", "observed-drawbacks.json"),
        "utf8",
      ),
    );
    const capturable = JSON.parse(
      await readFile(
        join(
          REPOSITORY_ROOT,
          "data",
          "catalog",
          "capturable-king-drawbacks-v3.json",
        ),
        "utf8",
      ),
    );
    const irresistible = canonical.entries.find(
      (entry) => entry.id === "irresistible",
    );
    irresistible.implementationStatus = "unsupported";

    const errors = await validateCapturableKingCatalog(
      canonical,
      capturable,
      { checkFiles: false },
    );
    expect(errors).toContain(
      "Frozen observed catalog rule irresistible must remain partial.",
    );
  });

  it("rejects per-rule v3 schema types, required fields, and parameter domains that drift", async () => {
    const canonical = JSON.parse(
      await readFile(
        join(REPOSITORY_ROOT, "data", "catalog", "observed-drawbacks.json"),
        "utf8",
      ),
    );
    const capturable = JSON.parse(
      await readFile(
        join(
          REPOSITORY_ROOT,
          "data",
          "catalog",
          "capturable-king-drawbacks-v3.json",
        ),
        "utf8",
      ),
    );
    capturable.rules[0].stateSchema.properties.movesApplied.type = "number";
    capturable.rules[1].stateSchema.required = ["movesApplied"];
    capturable.rules[2].parameterSchema.properties.requiredType.enum.push(
      "pawn",
    );

    const errors = await validateCapturableKingCatalog(
      canonical,
      capturable,
      { checkFiles: false },
    );
    expect(errors).toContain(
      "Capturable-king rule femme-fatale stateSchema must match its canonical v3 schema.",
    );
    expect(errors).toContain(
      "Capturable-king rule nurturer stateSchema must match its canonical v3 schema.",
    );
    expect(errors).toContain(
      "Capturable-king rule triple-play parameterSchema must match its canonical v3 schema.",
    );
  });

  it("generates a schema-v2 conservative record without inferred replay claims", async () => {
    const catalog = {
      entries: [
        {
          id: "executable",
          implementationStatus: "implemented-unverified",
          fixture: "data/fixtures/unreviewed.json",
        },
        { id: "unsupported", implementationStatus: "unsupported" },
      ],
    };
    const generated = generateEvidenceMatrix(catalog);
    expect(generated.schemaVersion).toBe(2);
    expect(generated.entries).toHaveLength(2);
    expect(generated.entries[0].evidence.replay.disposition).toBe("waived");
    expect(generated.entries[0].evidence.replay.references).toEqual([]);
    await expect(
      validateEvidenceMatrix(catalog, generated, { checkFiles: false }),
    ).resolves.toEqual([]);
  });

  it("accepts typed case-level evidence with an executed, bound replay", async () => {
    const root = await fixtureRepository();
    const catalog = {
      entries: [{ id: "alpha", implementationStatus: "verified" }],
    };
    await expect(
      validateEvidenceMatrix(
        catalog,
        matrix("verified", completeVerifiedEvidence()),
        { repositoryRoot: root },
      ),
    ).resolves.toEqual([]);
  });

  it("rejects README strings, unrelated kinds, directories, and repeated-kind misuse", async () => {
    const root = await fixtureRepository();
    await writeFile(join(root, "README.md"), "# unrelated");
    const catalog = {
      entries: [{ id: "alpha", implementationStatus: "verified" }],
    };
    const bad = completeVerifiedEvidence();
    bad.specification = item("evidenced", ["README.md"]);
    bad.positive = item("evidenced", [specification()]);
    bad.negative = item("evidenced", [{
      ...vitestReference("negative"),
      path: "docs",
    }]);
    const errors = await validateEvidenceMatrix(
      catalog,
      matrix("verified", bad),
      { repositoryRoot: root },
    );
    expect(errors).toContain(
      "Rule alpha specification reference 1 must be a typed reference object.",
    );
    expect(errors).toContain(
      "Rule alpha positive reference 1 must use a Vitest reference.",
    );
    expect(errors).toContain(
      "Rule alpha negative reference 1 must target a statically included Vitest test file.",
    );
  });

  it("rejects a missing anchor and a skipped or nonexistent exact test", async () => {
    const root = await fixtureRepository();
    const catalog = {
      entries: [{ id: "alpha", implementationStatus: "verified" }],
    };
    const bad = completeVerifiedEvidence();
    bad.positive = item("evidenced", [{
      ...vitestReference("positive"),
      anchor: "drawback-evidence:alpha:negative",
    }]);
    bad.negative = item("evidenced", [{
      ...vitestReference("negative"),
      testName: "skipped alpha case",
    }]);
    const errors = await validateEvidenceMatrix(
      catalog,
      matrix("verified", bad),
      { repositoryRoot: root },
    );
    expect(errors).toContain(
      "Rule alpha positive reference 1 must use exact anchor drawback-evidence:alpha:positive.",
    );
    expect(errors).toContain(
      "Rule alpha negative reference 1 does not name an exact non-skipped static Vitest test immediately bound to its stable anchor.",
    );
  });

  it("rejects arbitrary not-applicable prose without an exact applicability anchor", async () => {
    const root = await fixtureRepository();
    const catalog = {
      entries: [{ id: "alpha", implementationStatus: "verified" }],
    };
    const bad = completeVerifiedEvidence();
    bad.promotion = item("not-applicable", []);
    bad.castling = item("not-applicable", [{
      ...specification("castling"),
      anchor: "drawback-evidence:alpha:promotion",
    }]);
    const errors = await validateEvidenceMatrix(
      catalog,
      matrix("verified", bad),
      { repositoryRoot: root },
    );
    expect(errors).toContain(
      "Rule alpha promotion not-applicable requires one exact specification applicability reference.",
    );
    expect(errors).toContain(
      "Rule alpha castling reference 1 must use exact anchor drawback-evidence:alpha:castling.",
    );
  });

  it("rejects a malformed, wrongly bound, or unexecuted replay", async () => {
    const root = await fixtureRepository();
    const catalog = {
      entries: [{ id: "alpha", implementationStatus: "verified" }],
    };
    await writeFile(
      join(root, "data", "fixtures", "alpha.json"),
      JSON.stringify({ ruleId: "beta" }),
    );
    await writeFile(
      join(root, "packages", "engine", "src", "alpha.test.ts"),
      [
        'import { it } from "vitest";',
        "// data/fixtures/alpha.json",
        "// drawback-evidence:alpha:replay",
        'it("replays alpha fixture", () => {});',
        "// drawback-evidence:alpha:negative",
        'it.skip("skipped alpha case", () => {});',
      ].join("\n"),
    );
    const bad = completeVerifiedEvidence();
    bad.replay = item("evidenced", [{
      ...replayReference(),
      runner: {
        path: "packages/engine/src/alpha.test.ts",
        testName: "skipped alpha case",
      },
    }]);
    const errors = await validateEvidenceMatrix(
      catalog,
      matrix("verified", bad),
      { repositoryRoot: root },
    );
    expect(errors).toContain(
      "Rule alpha replay reference 1 fixture ruleId does not match alpha.",
    );
    expect(errors).toContain(
      "Rule alpha replay reference 1 runner does not name an exact non-skipped static Vitest test immediately bound to its stable anchor.",
    );
    expect(errors).toContain(
      "Rule alpha replay reference 1 runner test is not immediately and statically bound to its fixture path.",
    );
  });

  it("rejects status drift and missing catalog entries", async () => {
    const catalog = {
      entries: [
        { id: "alpha", implementationStatus: "implemented-unverified" },
        { id: "beta", implementationStatus: "unsupported" },
      ],
    };
    const candidate = {
      schemaVersion: 2,
      entries: [
        matrixEntry("partial", evidenceWith()),
      ],
    };
    const errors = await validateEvidenceMatrix(catalog, candidate, {
      checkFiles: false,
    });
    expect(errors).toContain(
      "Rule alpha status partial does not match catalog status implemented-unverified.",
    );
    expect(errors).toContain("Evidence matrix is missing catalog rule beta.");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a repository-internal symlink whose canonical target escapes",
    async () => {
      const root = await fixtureRepository();
      const outside = await mkdtemp(join(tmpdir(), "drawback-outside-"));
      await writeFile(join(outside, "outside.md"), "<!-- drawback-evidence:alpha:specification -->");
      await symlink(
        join(outside, "outside.md"),
        join(root, "docs", "rules", "escape.md"),
      );
      const catalog = {
        entries: [{ id: "alpha", implementationStatus: "verified" }],
      };
      const bad = completeVerifiedEvidence();
      bad.specification = item("evidenced", [{
        ...specification(),
        path: "docs/rules/escape.md",
      }]);
      await expect(
        validateEvidenceMatrix(
          catalog,
          matrix("verified", bad),
          { repositoryRoot: root },
        ),
      ).resolves.toContain(
        "Rule alpha specification reference 1 path is not a regular file: docs/rules/escape.md.",
      );
    },
  );
});
