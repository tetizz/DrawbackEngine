# Rule verification evidence

`data/catalog/rule-verification-evidence.json` is the machine-readable
verification checklist for every observed drawback. It is deliberately
separate from implementation status: executable code and broad test coverage
do not prove that an interpretation matches the original game.

Each rule records the evidence disposition for:

- a written rule specification;
- positive legal behavior;
- negative illegal behavior;
- edge cases;
- promotion;
- castling;
- en passant;
- start-of-turn loss;
- a normal-operation replay.

Schema 2 uses typed references rather than bare paths:

- a `specification` reference targets a Markdown file and an exact
  `drawback-evidence:<rule-id>:<category>` HTML-comment anchor;
- a `vitest` reference targets a statically included `*.test.ts`, `*.test.tsx`,
  or `scripts/*.test.mjs` file, the exact non-skipped test name, and the
  corresponding stable source anchor;
- a `replay` reference binds a JSON fixture whose `ruleId` matches the rule to
  an exact non-skipped Vitest runner. The runner must statically name the
  fixture path.

The dispositions have strict meanings:

- `evidenced` requires one or more correctly typed references for that exact
  rule and category;
- `not-applicable` is permitted only for promotion, castling, en passant, and
  start-of-turn loss. It requires a typed specification reference to the exact
  rule/category applicability anchor; prose alone is insufficient;
- `missing` records required evidence that does not exist;
- `waived` records deferred applicability or evidence review.

A waiver is not an exemption. Both `waived` and `missing` prevent a rule from
being marked `verified`. Specification, positive, negative, edge, and replay
categories must always be `evidenced`; they can never be declared
`not-applicable`. This distinction makes incomplete review visible without
guessing that a chess edge case cannot affect a rule.

Run the gate with:

```text
pnpm catalog:verify-evidence
```

The gate checks exact catalog coverage, unique rule IDs, status alignment,
the complete category set, reference type and category, stable anchors, exact
runnable test names, replay-to-rule and replay-to-runner binding, and canonical
file containment. Directories, skipped tests, unrelated files, and symlinks are
not accepted as evidence. CI runs it independently of the unit test suite, and
the repository-wide `pnpm check` command includes the gate.

## Current conservative baseline

The initial schema-2 matrix makes no inferred evidence claims. Catalog
descriptions are discovery metadata rather than curated written specifications;
catalog test-file pointers do not identify exact test cases; and the presence
of a fixture does not prove that CI executes it semantically. Every category,
including replay, therefore remains waived pending a per-rule audit with typed
references. Special-move and loss applicability also remains waived until each
rule is reviewed individually. No implementation status is upgraded by this
baseline.

To update the mechanically derived baseline after a catalog refresh, run:

```text
node scripts/validate-rule-verification-evidence.mjs --write
```

Review the resulting diff. Replace waivers with `evidenced`, `missing`, or
`not-applicable` only after examining the rule specification and focused test
cases. Do not use regeneration after hand-curated applicability work unless
the resulting waiver reset is intentional.
