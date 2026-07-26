/* global process */
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = resolve(REPOSITORY_ROOT, "data/catalog/observed-drawbacks.json");
const MATRIX_PATH = resolve(
  REPOSITORY_ROOT,
  "data/catalog/rule-verification-evidence.json",
);
const CAPTURABLE_CATALOG_PATH = resolve(
  REPOSITORY_ROOT,
  "data/catalog/capturable-king-drawbacks-v3.json",
);
const CAPTURABLE_REGISTRY_PATH =
  "packages/drawback-engine/src/rules/capturable-king-rules.ts";
const CAPTURABLE_DOC_PATH = "docs/rules/capturable-king/README.md";
const NO_PARAMETERS_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const MOVES_APPLIED_STATE_SCHEMA = {
  type: "object",
  properties: {
    movesApplied: {
      type: "integer",
      minimum: 0,
    },
  },
  required: ["movesApplied"],
  additionalProperties: false,
};
const CAPTURABLE_RULES = [
  {
    id: "femme-fatale",
    variableName: "femmeFataleRule",
    expectedFrozenStatus: "unsupported",
    parameterSchema: NO_PARAMETERS_SCHEMA,
    stateSchema: MOVES_APPLIED_STATE_SCHEMA,
  },
  {
    id: "nurturer",
    variableName: "nurturerRule",
    expectedFrozenStatus: "unsupported",
    parameterSchema: NO_PARAMETERS_SCHEMA,
    stateSchema: {
      type: "object",
      properties: {
        movesApplied: {
          type: "integer",
          minimum: 0,
        },
        hasPromotedPawn: {
          type: "boolean",
        },
      },
      required: ["movesApplied", "hasPromotedPawn"],
      additionalProperties: false,
    },
  },
  {
    id: "triple-play",
    variableName: "triplePlayRule",
    expectedFrozenStatus: "unsupported",
    parameterSchema: {
      type: "object",
      properties: {
        requiredType: {
          type: "string",
          enum: ["bishop", "knight"],
        },
      },
      required: ["requiredType"],
      additionalProperties: false,
    },
    stateSchema: MOVES_APPLIED_STATE_SCHEMA,
  },
  {
    id: "you-best-not-miss",
    variableName: "youBestNotMissRule",
    expectedFrozenStatus: "unsupported",
    parameterSchema: NO_PARAMETERS_SCHEMA,
    stateSchema: {
      type: "object",
      properties: {
        movesApplied: {
          type: "integer",
          minimum: 0,
        },
        mustCaptureKingNextTurn: {
          type: "boolean",
        },
      },
      required: ["movesApplied", "mustCaptureKingNextTurn"],
      additionalProperties: false,
    },
  },
  {
    id: "irresistible",
    variableName: "capturableKingIrresistibleRule",
    expectedFrozenStatus: "partial",
    parameterSchema: NO_PARAMETERS_SCHEMA,
    stateSchema: MOVES_APPLIED_STATE_SCHEMA,
  },
];
const CAPTURABLE_TEST_PATHS = [
  "packages/drawback-engine/src/rules/capturable-king-rules.test.ts",
  "packages/chess-core/src/capturable-king-rules.integration.test.ts",
  "packages/chess-core/src/public-game-trace.test.ts",
];

export const EVIDENCE_CATEGORIES = [
  "specification",
  "positive",
  "negative",
  "edge",
  "promotion",
  "castling",
  "enPassant",
  "startOfTurnLoss",
  "replay",
];

const CORE_CATEGORIES = new Set([
  "specification",
  "positive",
  "negative",
  "edge",
  "replay",
]);
const SPECIAL_CATEGORIES = new Set([
  "promotion",
  "castling",
  "enPassant",
  "startOfTurnLoss",
]);
const IMPLEMENTATION_STATUSES = new Set([
  "verified",
  "implemented-unverified",
  "partial",
  "unsupported",
]);
const DISPOSITIONS = new Set([
  "evidenced",
  "missing",
  "not-applicable",
  "waived",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(candidate, expected, label, errors) {
  if (!isRecord(candidate)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  const actual = Object.keys(candidate).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    errors.push(
      `${label} must contain exactly: ${wanted.join(", ")}.`,
    );
    return false;
  }
  return true;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  return value;
}

function matchesCanonicalSchema(candidate, expected) {
  return (
    JSON.stringify(canonicalJsonValue(candidate))
    === JSON.stringify(canonicalJsonValue(expected))
  );
}

function evidenceItem(disposition, references, rationale) {
  return { disposition, references, rationale };
}

export function generateEvidenceMatrix(catalog) {
  if (!isRecord(catalog) || !Array.isArray(catalog.entries)) {
    throw new Error("Observed catalog must contain an entries array.");
  }

  return {
    schemaVersion: 2,
    policy:
      "Verified rules require typed, case-level specification, Vitest, applicability, and semantically executed replay references. Missing and waived categories block verified status.",
    entries: catalog.entries.map((candidate) => {
      if (!isRecord(candidate) || typeof candidate.id !== "string") {
        throw new Error("Observed catalog contains an entry without an id.");
      }
      const implementationStatus =
        typeof candidate.implementationStatus === "string"
          ? candidate.implementationStatus
          : "unsupported";
      const executable = implementationStatus !== "unsupported";
      const unavailable = "No executable implementation is currently claimed.";
      const unreviewed =
        "Case-level evidence and applicability have not been reviewed; this waiver blocks verified status.";
      return {
        ruleId: candidate.id,
        implementationStatus,
        evidence: Object.fromEntries(EVIDENCE_CATEGORIES.map((category) => [
          category,
          evidenceItem("waived", [], executable ? unreviewed : unavailable),
        ])),
      };
    }),
  };
}

function expectedAnchor(ruleId, category) {
  return `drawback-evidence:${ruleId}:${category}`;
}

function isIncludedVitestPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return (
    /^(?:packages|apps)\/.+\.test\.tsx?$/.test(normalized) ||
    /^scripts\/.+\.test\.mjs$/.test(normalized)
  );
}

function hasExactAnchoredRunnableTest(source, testName, anchor) {
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(
    String.raw`(?:^|[\s;])(?:it|test)\s*\(\s*(["'\`])${escaped}\1\s*,`,
    "gm",
  );
  const marker = `// ${anchor}`;
  for (const match of source.matchAll(declaration)) {
    const declarationIndex = match.index ?? -1;
    const markerIndex = source.lastIndexOf(marker, declarationIndex);
    if (markerIndex < 0) {
      continue;
    }
    const between = source.slice(markerIndex + marker.length, declarationIndex);
    if (/^(?:\s|\/\/[^\r\n]*(?:\r?\n|$))*$/.test(between)) {
      return true;
    }
  }
  return false;
}

function hasFixtureBoundReplayRunner(source, testName, anchor, fixturePath) {
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(
    String.raw`(?:^|[\s;])(?:it|test)\s*\(\s*(["'\`])${escaped}\1\s*,`,
    "gm",
  );
  const marker = `// ${anchor}`;
  const normalizedPath = fixturePath.replaceAll("\\", "/");
  for (const match of source.matchAll(declaration)) {
    const declarationIndex = match.index ?? -1;
    const markerIndex = source.lastIndexOf(marker, declarationIndex);
    if (markerIndex < 0) {
      continue;
    }
    const between = source.slice(markerIndex + marker.length, declarationIndex);
    if (
      /^(?:\s|\/\/[^\r\n]*(?:\r?\n|$))*$/.test(between) &&
      between.replaceAll("\\", "/").includes(normalizedPath)
    ) {
      return true;
    }
  }
  return false;
}

async function checkedFile(repositoryRoot, path, label, errors) {
  if (typeof path !== "string" || path.length === 0) {
    errors.push(`${label} path must be a non-empty repository-relative string.`);
    return null;
  }
  const lexicalPath = resolve(repositoryRoot, path);
  const lexicalRelative = relative(repositoryRoot, lexicalPath);
  if (
    lexicalRelative === "" ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`)
  ) {
    errors.push(`${label} path escapes the repository: ${path}.`);
    return null;
  }
  try {
    const rootCanonical = await realpath(repositoryRoot);
    const metadata = await lstat(lexicalPath);
    if (!metadata.isFile()) {
      errors.push(`${label} path is not a regular file: ${path}.`);
      return null;
    }
    const canonicalPath = await realpath(lexicalPath);
    const canonicalRelative = relative(rootCanonical, canonicalPath);
    if (
      canonicalRelative === "" ||
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`)
    ) {
      errors.push(`${label} path resolves outside the repository: ${path}.`);
      return null;
    }
    return { canonicalPath, source: await readFile(canonicalPath, "utf8") };
  } catch {
    errors.push(`${label} references a missing or unreadable file: ${path}.`);
    return null;
  }
}

function validateReferenceShape(reference, ruleId, category, label, errors) {
  if (!isRecord(reference) || typeof reference.kind !== "string") {
    errors.push(`${label} must be a typed reference object.`);
    return false;
  }
  if (category === "specification") {
    if (reference.kind !== "specification") {
      errors.push(`${label} must use a specification reference.`);
      return false;
    }
  } else if (category === "replay") {
    if (reference.kind !== "replay") {
      errors.push(`${label} must use a replay reference.`);
      return false;
    }
  } else if (reference.kind !== "vitest") {
    errors.push(`${label} must use a Vitest reference.`);
    return false;
  }
  const anchor = expectedAnchor(ruleId, category);
  if (reference.anchor !== anchor) {
    errors.push(`${label} must use exact anchor ${anchor}.`);
    return false;
  }
  return true;
}

async function validateSpecificationReference(
  reference,
  ruleId,
  category,
  repositoryRoot,
  label,
  errors,
) {
  if (
    typeof reference.path !== "string" ||
    !reference.path.toLowerCase().endsWith(".md")
  ) {
    errors.push(`${label} specification path must target Markdown.`);
    return;
  }
  const file = await checkedFile(repositoryRoot, reference.path, label, errors);
  if (
    file !== null &&
    !file.source.includes(`<!-- ${expectedAnchor(ruleId, category)} -->`)
  ) {
    errors.push(`${label} Markdown file lacks its exact stable anchor.`);
  }
}

async function validateVitestReference(
  reference,
  ruleId,
  category,
  repositoryRoot,
  label,
  errors,
) {
  if (typeof reference.path !== "string" || !isIncludedVitestPath(reference.path)) {
    errors.push(`${label} must target a statically included Vitest test file.`);
    return;
  }
  if (typeof reference.testName !== "string" || reference.testName.length === 0) {
    errors.push(`${label} must name one exact runnable Vitest test.`);
    return;
  }
  const file = await checkedFile(repositoryRoot, reference.path, label, errors);
  if (file === null) {
    return;
  }
  if (
    !hasExactAnchoredRunnableTest(
      file.source,
      reference.testName,
      expectedAnchor(ruleId, category),
    )
  ) {
    errors.push(
      `${label} does not name an exact non-skipped static Vitest test immediately bound to its stable anchor.`,
    );
  }
}

async function validateReplayReference(
  reference,
  ruleId,
  repositoryRoot,
  label,
  errors,
) {
  if (typeof reference.fixturePath !== "string") {
    errors.push(`${label} must name a replay fixturePath.`);
    return;
  }
  const fixture = await checkedFile(
    repositoryRoot,
    reference.fixturePath,
    `${label} fixture`,
    errors,
  );
  if (fixture !== null) {
    try {
      const parsed = JSON.parse(fixture.source);
      if (!isRecord(parsed) || parsed.ruleId !== ruleId) {
        errors.push(`${label} fixture ruleId does not match ${ruleId}.`);
      }
    } catch {
      errors.push(`${label} fixture is not valid JSON.`);
    }
  }
  if (!isRecord(reference.runner)) {
    errors.push(`${label} must identify an exact semantic replay runner.`);
    return;
  }
  const runner = {
    ...reference.runner,
    kind: "vitest",
    anchor: reference.anchor,
  };
  await validateVitestReference(
    runner,
    ruleId,
    "replay",
    repositoryRoot,
    `${label} runner`,
    errors,
  );
  if (fixture !== null && typeof reference.runner.path === "string") {
    const runnerFile = await checkedFile(
      repositoryRoot,
      reference.runner.path,
      `${label} runner`,
      errors,
    );
    if (
      runnerFile !== null &&
      typeof reference.runner.testName === "string" &&
      !hasFixtureBoundReplayRunner(
        runnerFile.source,
        reference.runner.testName,
        expectedAnchor(ruleId, "replay"),
        reference.fixturePath,
      )
    ) {
      errors.push(
        `${label} runner test is not immediately and statically bound to its fixture path.`,
      );
    }
  }
}

async function validateTypedReference(
  reference,
  ruleId,
  category,
  repositoryRoot,
  label,
  errors,
) {
  if (!validateReferenceShape(reference, ruleId, category, label, errors)) {
    return;
  }
  if (reference.kind === "specification") {
    await validateSpecificationReference(
      reference,
      ruleId,
      category,
      repositoryRoot,
      label,
      errors,
    );
  } else if (reference.kind === "vitest") {
    await validateVitestReference(
      reference,
      ruleId,
      category,
      repositoryRoot,
      label,
      errors,
    );
  } else {
    await validateReplayReference(
      reference,
      ruleId,
      repositoryRoot,
      label,
      errors,
    );
  }
}

export async function validateEvidenceMatrix(catalog, matrix, options = {}) {
  const checkFiles = options.checkFiles ?? true;
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const errors = [];
  if (!isRecord(catalog) || !Array.isArray(catalog.entries)) {
    return ["Observed catalog must contain an entries array."];
  }
  if (!isRecord(matrix) || matrix.schemaVersion !== 2) {
    return ["Evidence matrix must be an object with schemaVersion 2."];
  }
  if (!Array.isArray(matrix.entries)) {
    return ["Evidence matrix must contain an entries array."];
  }

  const catalogById = new Map();
  for (const candidate of catalog.entries) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !IMPLEMENTATION_STATUSES.has(candidate.implementationStatus)
    ) {
      errors.push("Catalog contains an invalid id or implementation status.");
      continue;
    }
    if (catalogById.has(candidate.id)) {
      errors.push(`Catalog contains duplicate rule id ${candidate.id}.`);
    }
    catalogById.set(candidate.id, candidate);
  }

  const matrixIds = new Set();
  for (const candidate of matrix.entries) {
    if (!isRecord(candidate) || typeof candidate.ruleId !== "string") {
      errors.push("Evidence matrix contains an entry without a ruleId.");
      continue;
    }
    const label = `Rule ${candidate.ruleId}`;
    if (matrixIds.has(candidate.ruleId)) {
      errors.push(`${label} appears more than once.`);
      continue;
    }
    matrixIds.add(candidate.ruleId);
    const catalogEntry = catalogById.get(candidate.ruleId);
    if (catalogEntry === undefined) {
      errors.push(`${label} is not present in the observed catalog.`);
      continue;
    }
    if (candidate.implementationStatus !== catalogEntry.implementationStatus) {
      errors.push(
        `${label} status ${String(candidate.implementationStatus)} does not match catalog status ${catalogEntry.implementationStatus}.`,
      );
    }
    if (!isRecord(candidate.evidence)) {
      errors.push(`${label} must contain an evidence object.`);
      continue;
    }
    const categoryNames = Object.keys(candidate.evidence);
    for (const category of EVIDENCE_CATEGORIES) {
      const item = candidate.evidence[category];
      if (!isRecord(item)) {
        errors.push(`${label} is missing ${category} evidence.`);
        continue;
      }
      if (!DISPOSITIONS.has(item.disposition)) {
        errors.push(`${label} ${category} has an invalid disposition.`);
      }
      const references = Array.isArray(item.references) ? item.references : [];
      if (!Array.isArray(item.references)) {
        errors.push(`${label} ${category} references must be an array.`);
      }
      if (typeof item.rationale !== "string" || item.rationale.length === 0) {
        errors.push(`${label} ${category} must have a rationale.`);
      }
      if (item.disposition === "evidenced" && references.length === 0) {
        errors.push(`${label} ${category} is evidenced without references.`);
      }
      if (
        (item.disposition === "missing" || item.disposition === "waived") &&
        references.length !== 0
      ) {
        errors.push(`${label} ${category} may not reference evidence while ${item.disposition}.`);
      }
      if (item.disposition === "not-applicable") {
        if (!SPECIAL_CATEGORIES.has(category)) {
          errors.push(`${label} ${category} cannot be not-applicable.`);
        }
        if (
          references.length !== 1 ||
          !isRecord(references[0]) ||
          references[0].kind !== "specification"
        ) {
          errors.push(
            `${label} ${category} not-applicable requires one exact specification applicability reference.`,
          );
        }
      }
      if (candidate.implementationStatus === "verified") {
        const acceptable = CORE_CATEGORIES.has(category)
          ? item.disposition === "evidenced"
          : item.disposition === "evidenced" ||
            item.disposition === "not-applicable";
        if (!acceptable) {
          errors.push(
            `${label} cannot be verified while ${category} is ${String(item.disposition)}.`,
          );
        }
      }
      for (const [index, reference] of references.entries()) {
        const referenceLabel = `${label} ${category} reference ${String(index + 1)}`;
        if (item.disposition === "not-applicable") {
          if (
            isRecord(reference) &&
            reference.kind === "specification" &&
            reference.anchor !== expectedAnchor(candidate.ruleId, category)
          ) {
            errors.push(
              `${referenceLabel} must use exact anchor ${expectedAnchor(candidate.ruleId, category)}.`,
            );
          } else if (
            isRecord(reference) &&
            reference.kind === "specification" &&
            checkFiles
          ) {
            await validateSpecificationReference(
              reference,
              candidate.ruleId,
              category,
              repositoryRoot,
              referenceLabel,
              errors,
            );
          }
        } else if (checkFiles) {
          await validateTypedReference(
            reference,
            candidate.ruleId,
            category,
            repositoryRoot,
            referenceLabel,
            errors,
          );
        } else {
          validateReferenceShape(
            reference,
            candidate.ruleId,
            category,
            referenceLabel,
            errors,
          );
        }
      }
    }
    for (const category of categoryNames) {
      if (!EVIDENCE_CATEGORIES.includes(category)) {
        errors.push(`${label} contains unknown evidence category ${category}.`);
      }
    }
  }
  for (const ruleId of catalogById.keys()) {
    if (!matrixIds.has(ruleId)) {
      errors.push(`Evidence matrix is missing catalog rule ${ruleId}.`);
    }
  }
  return errors;
}

function validateObjectSchema(schema, label, errors) {
  if (
    !exactKeys(
      schema,
      ["type", "properties", "required", "additionalProperties"],
      label,
      errors,
    )
  ) {
    return;
  }
  if (
    schema.type !== "object"
    || !isRecord(schema.properties)
    || !Array.isArray(schema.required)
    || schema.additionalProperties !== false
  ) {
    errors.push(
      `${label} must be a closed object schema with properties and required arrays.`,
    );
    return;
  }
  const required = new Set();
  for (const propertyName of schema.required) {
    if (
      typeof propertyName !== "string"
      || !(propertyName in schema.properties)
    ) {
      errors.push(`${label} has an invalid required property.`);
      continue;
    }
    if (required.has(propertyName)) {
      errors.push(`${label} repeats required property ${propertyName}.`);
    }
    required.add(propertyName);
  }
  for (const [propertyName, propertySchema] of Object.entries(
    schema.properties,
  )) {
    if (
      propertyName.length === 0
      || !isRecord(propertySchema)
      || typeof propertySchema.type !== "string"
    ) {
      errors.push(`${label} property ${propertyName} has no typed schema.`);
    }
  }
}

function validateCanonicalBoundary(catalog, expectedRules, errors) {
  if (
    !isRecord(catalog)
    || !isRecord(catalog.counts)
    || !Array.isArray(catalog.entries)
  ) {
    errors.push("Frozen observed catalog has an invalid shape.");
    return;
  }
  if (
    catalog.counts.observed !== 194
    || catalog.counts.executable !== 182
    || catalog.counts.unsupported !== 12
    || catalog.entries.length !== 194
  ) {
    errors.push(
      "Frozen observed catalog must retain 194 observed, 182 executable, and 12 unsupported rules.",
    );
  }
  const actualExecutable = catalog.entries.filter(
    (entry) =>
      isRecord(entry) && entry.implementationStatus !== "unsupported",
  ).length;
  const actualUnsupported = catalog.entries.filter(
    (entry) =>
      isRecord(entry) && entry.implementationStatus === "unsupported",
  ).length;
  if (actualExecutable !== 182 || actualUnsupported !== 12) {
    errors.push(
      "Frozen observed catalog entry statuses no longer match the 182/12 boundary.",
    );
  }
  const canonicalById = new Map(
    catalog.entries
      .filter((entry) => isRecord(entry) && typeof entry.id === "string")
      .map((entry) => [entry.id, entry]),
  );
  for (const rule of expectedRules) {
    if (
      canonicalById.get(rule.id)?.implementationStatus
        !== rule.expectedFrozenStatus
    ) {
      errors.push(
        `Frozen observed catalog rule ${rule.id} must remain ${rule.expectedFrozenStatus}.`,
      );
    }
  }
}

/**
 * Validates the authority-scoped v3 fragment without changing the frozen
 * standard-authority evidence matrix or its 194/182/12 release boundary.
 */
export async function validateCapturableKingCatalog(
  canonicalCatalog,
  capturableCatalog,
  options = {},
) {
  const checkFiles = options.checkFiles ?? true;
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const errors = [];
  const expectedIds = CAPTURABLE_RULES.map((rule) => rule.id);

  validateCanonicalBoundary(canonicalCatalog, CAPTURABLE_RULES, errors);
  if (
    !exactKeys(
      capturableCatalog,
      [
        "schemaVersion",
        "catalogId",
        "authorityId",
        "migrationBoundary",
        "rules",
      ],
      "Capturable-king catalog",
      errors,
    )
  ) {
    return errors;
  }
  if (
    capturableCatalog.schemaVersion !== 3
    || capturableCatalog.catalogId !== "capturable-king-rules-v3"
    || capturableCatalog.authorityId !== "capturable-king/v1"
    || !Array.isArray(capturableCatalog.rules)
  ) {
    errors.push(
      "Capturable-king catalog must identify schema 3 and capturable-king/v1.",
    );
    return errors;
  }
  if (
    exactKeys(
      capturableCatalog.migrationBoundary,
      ["frozenCatalog", "frozenPreparedClassCount", "reason"],
      "Capturable-king migration boundary",
      errors,
    )
  ) {
    if (
      capturableCatalog.migrationBoundary.frozenCatalog
        !== "data/catalog/observed-drawbacks.json"
      || capturableCatalog.migrationBoundary.frozenPreparedClassCount !== 182
      || typeof capturableCatalog.migrationBoundary.reason !== "string"
      || capturableCatalog.migrationBoundary.reason.length === 0
    ) {
      errors.push(
        "Capturable-king migration boundary must preserve the frozen 182-class catalog.",
      );
    }
  }

  const actualIds = capturableCatalog.rules.map((rule) =>
    isRecord(rule) ? rule.id : undefined
  );
  if (
    actualIds.length !== expectedIds.length
    || actualIds.some((ruleId, index) => ruleId !== expectedIds[index])
  ) {
    errors.push(
      `Capturable-king rules must be ordered exactly: ${expectedIds.join(", ")}.`,
    );
  }

  let registrySource = null;
  let documentationSource = null;
  if (checkFiles) {
    registrySource = await checkedFile(
      repositoryRoot,
      CAPTURABLE_REGISTRY_PATH,
      "Capturable-king registry",
      errors,
    );
    documentationSource = await checkedFile(
      repositoryRoot,
      CAPTURABLE_DOC_PATH,
      "Capturable-king documentation",
      errors,
    );
  }

  for (const [index, candidate] of capturableCatalog.rules.entries()) {
    const expected = CAPTURABLE_RULES[index];
    const ruleId = isRecord(candidate) && typeof candidate.id === "string"
      ? candidate.id
      : `index-${String(index)}`;
    const label = `Capturable-king rule ${ruleId}`;
    if (
      !exactKeys(
        candidate,
        [
          "id",
          "name",
          "observedDescription",
          "sourceEvidence",
          "authorityId",
          "parameterSchema",
          "stateSchema",
          "implementationStatus",
          "ruleFamily",
          "tests",
          "fixture",
          "ambiguities",
        ],
        label,
        errors,
      )
    ) {
      continue;
    }
    if (
      candidate.id !== expected?.id
      || typeof candidate.name !== "string"
      || candidate.name.length === 0
      || typeof candidate.observedDescription !== "string"
      || candidate.observedDescription.length === 0
      || candidate.authorityId !== "capturable-king/v1"
      || candidate.implementationStatus !== "implemented-unverified"
      || typeof candidate.ruleFamily !== "string"
      || candidate.ruleFamily.length === 0
      || typeof candidate.fixture !== "string"
      || candidate.fixture
        !== `data/fixtures/rules/capturable-king/${candidate.id}.json`
      || !Array.isArray(candidate.sourceEvidence)
      || candidate.sourceEvidence.length === 0
      || candidate.sourceEvidence.some(
        (evidence) => typeof evidence !== "string" || evidence.length === 0,
      )
      || !Array.isArray(candidate.ambiguities)
      || candidate.ambiguities.length === 0
      || candidate.ambiguities.some(
        (ambiguity) =>
          typeof ambiguity !== "string" || ambiguity.length === 0,
      )
    ) {
      errors.push(`${label} has invalid authority, status, or descriptive data.`);
    }
    validateObjectSchema(
      candidate.parameterSchema,
      `${label} parameterSchema`,
      errors,
    );
    validateObjectSchema(
      candidate.stateSchema,
      `${label} stateSchema`,
      errors,
    );
    if (
      expected !== undefined
      && !matchesCanonicalSchema(
        candidate.parameterSchema,
        expected.parameterSchema,
      )
    ) {
      errors.push(
        `${label} parameterSchema must match its canonical v3 schema.`,
      );
    }
    if (
      expected !== undefined
      && !matchesCanonicalSchema(candidate.stateSchema, expected.stateSchema)
    ) {
      errors.push(
        `${label} stateSchema must match its canonical v3 schema.`,
      );
    }
    if (
      !Array.isArray(candidate.tests)
      || candidate.tests.length !== CAPTURABLE_TEST_PATHS.length
      || candidate.tests.some(
        (testPath, testIndex) =>
          testPath !== CAPTURABLE_TEST_PATHS[testIndex],
      )
    ) {
      errors.push(
        `${label} must reference rule, session, and public-authority replay tests.`,
      );
    }

    if (!checkFiles) {
      continue;
    }
    for (const testPath of Array.isArray(candidate.tests)
      ? candidate.tests
      : []) {
      await checkedFile(
        repositoryRoot,
        testPath,
        `${label} test`,
        errors,
      );
    }
    const fixture = await checkedFile(
      repositoryRoot,
      candidate.fixture,
      `${label} fixture`,
      errors,
    );
    if (fixture !== null) {
      try {
        const parsed = JSON.parse(fixture.source);
        if (
          !isRecord(parsed)
          || parsed.ruleId !== candidate.id
          || parsed.authorityId !== "capturable-king/v1"
          || !Array.isArray(parsed.moves)
          || parsed.moves.length === 0
        ) {
          errors.push(
            `${label} fixture must bind its rule, authority, and non-empty replay.`,
          );
        }
      } catch {
        errors.push(`${label} fixture is not valid JSON.`);
      }
    }
    if (
      documentationSource !== null
      && !documentationSource.source.includes(
        `<!-- drawback-evidence:${candidate.id}:specification -->`,
      )
    ) {
      errors.push(`${label} documentation lacks its specification anchor.`);
    }
    if (registrySource !== null && expected !== undefined) {
      const variableName = expected.variableName;
      const declarationIndex = registrySource.source.indexOf(
        `export const ${variableName}`,
      );
      const declarationEnd = registrySource.source.indexOf(
        "\n};",
        declarationIndex,
      );
      const declaration = declarationIndex < 0 || declarationEnd < 0
        ? ""
        : registrySource.source.slice(declarationIndex, declarationEnd);
      if (
        !declaration.includes(`id: "${candidate.id}"`)
        || !declaration.includes('verification: "implemented-unverified"')
        || !declaration.includes(
          "supportedAuthorities: CAPTURABLE_KING_AUTHORITY",
        )
        || !registrySource.source.includes(`eraseRule(${variableName})`)
      ) {
        errors.push(
          `${label} does not match its authority-scoped executable registry export.`,
        );
      }
    }
  }
  if (
    registrySource !== null
    && !registrySource.source.includes(
      "export function resolveCapturableKingRule(",
    )
  ) {
    errors.push("Capturable-king registry must export its strict resolver.");
  }
  return errors;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const catalog = await readJson(CATALOG_PATH);
  if (process.argv.includes("--write")) {
    await writeFile(
      MATRIX_PATH,
      `${JSON.stringify(generateEvidenceMatrix(catalog), null, 2)}\n`,
    );
  }
  const matrix = await readJson(MATRIX_PATH);
  const capturableCatalog = await readJson(CAPTURABLE_CATALOG_PATH);
  const errors = [
    ...(await validateEvidenceMatrix(catalog, matrix)),
    ...(await validateCapturableKingCatalog(catalog, capturableCatalog)),
  ];
  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`${error}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Validated ${String(matrix.entries.length)} per-rule evidence records and ${String(capturableCatalog.rules.length)} authority-scoped v3 rules.\n`,
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
