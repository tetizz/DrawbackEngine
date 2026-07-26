/* global fetch, process */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SOURCE_URL = "https://www.chess.com/forum/view/general/all-drawbacks";
const DETECTOR_SOURCE_REVISION = "9c8d298c8af911a8c92b3cedc7ff37a7ca6cad82";
const DETECTOR_SOURCE_URL =
  `https://raw.githubusercontent.com/InvalidSE/DrawbackDetector/${DETECTOR_SOURCE_REVISION}/drawbacks.json`;
const OUTPUT = resolve("data/catalog/observed-drawbacks.json");
const FRAGMENTS = [
  "initial-drawbacks.json",
  "milestone-drawbacks.json",
  "parameterized-drawbacks.json",
  "expanded-drawbacks.json",
  "community-drawbacks.json",
  "community-drawbacks-two.json",
  "loss-drawbacks.json",
  "observed-rules-three.json",
  "observed-rules-four.json",
  "observed-rules-five.json",
  "observed-rules-six.json",
  "observed-rules-seven.json",
  "observed-rules-eight.json",
  "observed-rules-nine.json",
  "observed-rules-ten.json",
  "observed-rules-eleven.json",
];
const ID_ALIASES = new Map([
  ["ey-for-an-eye", "eye-for-an-eye"],
  ["the-scent-of-blood", "scent-of-blood"],
]);

function decodeHtml(value) {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("’", "'")
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replace(/\s+/gu, " ")
    .trim();
}

function slug(name) {
  const generated = name
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return ID_ALIASES.get(generated) ?? generated;
}

function paragraphText(segment) {
  return [...segment.matchAll(/<p[^>]*>(.*?)<\/p>/gsu)].flatMap((match) => {
    const body = match[1]
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<[^>]+>/gu, "");
    return body
      .split("\n")
      .map(decodeHtml)
      .filter(Boolean);
  });
}

function extractRange(html, startText, endText, includeEndParagraph = false) {
  const start = html.indexOf(startText);
  const endStart = html.indexOf(endText, start);
  if (start < 0 || endStart < 0) {
    throw new Error(`Could not locate catalog range ${startText} -> ${endText}.`);
  }
  const end = includeEndParagraph
    ? html.indexOf("</p>", endStart) + "</p>".length
    : endStart;
  return paragraphText(`<p>${html.slice(start, end)}`);
}

function pairEntries(values, evidence) {
  if (values.length % 2 !== 0) {
    throw new Error(
      `Observed catalog range has ${String(values.length)} paragraphs; expected name/description pairs.`,
    );
  }
  const entries = [];
  for (let index = 0; index < values.length; index += 2) {
    const observedName = values[index];
    const observedDescription = values[index + 1];
    if (observedName === undefined || observedDescription === undefined) {
      throw new Error("Observed catalog pairing invariant failed.");
    }
    entries.push({
      id: slug(observedName),
      observedName,
      observedDescription,
      sourceEvidence: evidence,
    });
  }
  return entries;
}

function detectorEntries(payload) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray(payload.drawbacks)
  ) {
    throw new Error("DrawbackDetector corpus has an unexpected shape.");
  }
  const groups = new Map();
  for (const candidate of payload.drawbacks) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.title !== "string" ||
      typeof candidate.description !== "string"
    ) {
      throw new Error("DrawbackDetector corpus contains a malformed observation.");
    }
    const observedName = decodeHtml(candidate.title);
    const description = decodeHtml(candidate.description);
    const id = slug(observedName);
    if (id.length === 0 || observedName.length === 0 || description.length === 0) {
      throw new Error(
        "DrawbackDetector corpus contains an empty title or description.",
      );
    }
    const existing = groups.get(id) ?? {
      id,
      observedName,
      descriptions: new Map(),
      observationCount: 0,
    };
    if (existing.observedName !== observedName) {
      throw new Error(
        `DrawbackDetector titles normalize to the same ID: ` +
        `${existing.observedName} and ${observedName}.`,
      );
    }
    existing.observationCount += 1;
    existing.descriptions.set(
      description,
      (existing.descriptions.get(description) ?? 0) + 1,
    );
    groups.set(id, existing);
  }
  const entries = [...groups.values()].map((group) => {
    const descriptions = [...group.descriptions.entries()]
      .sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([description]) => description);
    const observedDescription = descriptions[0];
    if (observedDescription === undefined) {
      throw new Error(`DrawbackDetector title ${group.observedName} has no description.`);
    }
    return {
      id: group.id,
      observedName: group.observedName,
      observedDescription,
      sourceEvidence: {
        sourceId: "github-invalidse-drawback-detector",
        kind: "drawbackchess-site-observation-corpus",
        repository: "https://github.com/InvalidSE/DrawbackDetector",
        publishedDate: null,
      },
      observationCount: group.observationCount,
      sampleDescriptions: descriptions.slice(0, 12),
    };
  });
  const corpusSize = payload.drawbacks.length;
  const groupedCount = entries.reduce(
    (sum, entry) => sum + entry.observationCount,
    0,
  );
  if (groupedCount !== corpusSize) {
    throw new Error("DrawbackDetector observation grouping lost records.");
  }
  return { entries, corpusSize };
}

async function implementedMetadata() {
  const entries = await Promise.all(
    FRAGMENTS.map(async (file) =>
      JSON.parse(
        await readFile(resolve("data/catalog", file), "utf8"),
      ),
    ),
  );
  return new Map(entries.flat().map((entry) => [entry.id, entry]));
}

async function main() {
  const [forumResponse, detectorResponse] = await Promise.all([
    fetch(SOURCE_URL),
    fetch(DETECTOR_SOURCE_URL),
  ]);
  if (!forumResponse.ok) {
    throw new Error(`Catalog source returned HTTP ${String(forumResponse.status)}.`);
  }
  if (!detectorResponse.ok) {
    throw new Error(
      `DrawbackDetector source returned HTTP ${String(detectorResponse.status)}.`,
    );
  }
  const html = await forumResponse.text();
  const detectorCorpus = detectorEntries(await detectorResponse.json());
  const detector = detectorCorpus.entries;
  const primary = pairEntries(
    extractRange(html, "Rook Buddies", "Hope that this list helped you"),
    {
      sourceId: "chess-com-forum-reply-5",
      kind: "community-compiled",
      author: "Truc1231",
      publishedDate: "2024-06-18",
    },
  );
  const update = pairEntries(
    extractRange(
      html,
      "Hand and Gigabrain",
      "If you can move your king, you must",
      true,
    ),
    {
      sourceId: "chess-com-forum-reply-13",
      kind: "community-compiled",
      author: "Truc1231",
      publishedDate: "2024-06-28",
    },
  );
  const metadata = await implementedMetadata();
  const observed = new Map();
  for (const entry of [...primary, ...update]) {
    observed.set(entry.id, entry);
  }
  const detectorById = new Map(detector.map((entry) => [entry.id, entry]));
  for (const entry of detector) {
    if (!observed.has(entry.id)) {
      observed.set(entry.id, entry);
    }
  }
  for (const [id, implementation] of metadata) {
    if (!observed.has(id)) {
      observed.set(id, {
        id,
        observedName: implementation.name,
        observedDescription:
          implementation.description ??
          "No attributable rule description has been located.",
        sourceEvidence: {
          sourceId: "repository-research",
          kind: "repository-documented",
          author: null,
          publishedDate: null,
        },
      });
    }
  }
  const entries = [...observed.values()]
    .map((entry) => {
      const implementation = metadata.get(entry.id);
      const detectorObservation = detectorById.get(entry.id);
      const implementationStatus =
        implementation?.implementationStatus ?? "unsupported";
      return {
        ...entry,
        ...(detectorObservation === undefined
          ? {}
          : {
              observedFrequency: {
                sourceId: "github-invalidse-drawback-detector",
                count: detectorObservation.observationCount,
                corpusSize: detectorCorpus.corpusSize,
              },
              sampleDescriptions: detectorObservation.sampleDescriptions,
              ...(entry.sourceEvidence.sourceId ===
              "github-invalidse-drawback-detector"
                ? {}
                : {
                    corroboratingEvidence: [
                      detectorObservation.sourceEvidence,
                    ],
                  }),
            }),
        implementationStatus,
        ruleFamily: implementation?.ruleFamily ?? "unclassified",
        parameterSchema: implementation?.parameterSchema ?? null,
        tests: implementation?.tests ?? [],
        fixture: implementation?.fixture ?? null,
        ambiguities:
          implementationStatus === "unsupported"
            ? ["Executable semantics have not yet been reviewed and tested."]
            : implementation?.ambiguities ?? [],
      };
    })
    .sort((left, right) => left.observedName.localeCompare(right.observedName));

  if (entries.length < 190) {
    throw new Error(
      `Import produced only ${String(entries.length)} unique observed drawbacks.`,
    );
  }
  const output = {
    catalogVersion: 1,
    generatedFrom: {
      url: SOURCE_URL,
      additionalSources: [
        {
          url: "https://github.com/InvalidSE/DrawbackDetector",
          sourceRevision: DETECTOR_SOURCE_REVISION,
          dataUrl: DETECTOR_SOURCE_URL,
          retrievedDate: "2026-07-24",
          evidenceClass: "drawbackchess-site-observation-corpus",
          observationCount: detectorCorpus.corpusSize,
        },
      ],
      retrievedDate: "2026-07-24",
      evidenceClass: "attributable-community-glossary",
      caveat:
        "The forum author states that the list is incomplete. Detector counts " +
        "describe its collected game sample and are not unbiased global frequencies. " +
        "Entries are not official executable specifications.",
    },
    counts: {
      observed: entries.length,
      executable: entries.filter(
        ({ implementationStatus }) =>
          implementationStatus !== "unsupported",
      ).length,
      unsupported: entries.filter(
        ({ implementationStatus }) =>
          implementationStatus === "unsupported",
      ).length,
    },
    entries,
  };
  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Wrote ${String(entries.length)} observed drawbacks to ${OUTPUT}\n`,
  );
}

await main();
