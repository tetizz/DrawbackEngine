# Unsupported drawbacks: v3 evidence and implementation plan

Last reviewed: 2026-07-24

## 2026-07-25 implementation update

The `capturable-king/v1` authority now exists. Femme Fatale, Nurturer, Triple
Play, and You Best Not Miss have executable `implemented-unverified`
interpretations in the authority-scoped
`data/catalog/capturable-king-drawbacks-v3.json` registry. Specifications and
remaining ambiguities are recorded in
`docs/rules/capturable-king/README.md`.

They intentionally remain outside the frozen 182-class standard-authority v2
registry, corpus, and model artifacts. This preserves the freeze boundary
below: the canonical `observed-drawbacks.json` still reports those titles as
unsupported by that released standard pipeline. A future v3 model migration
must version the authority, label order, symbolic vectors, corpus, calibration,
and evaluation protocol before making a learned all-authority coverage claim.
Triple Play generation is restricted to the only observed parameter values,
`bishop` and `knight`; the complete site domain remains unverified.

## Scope and freeze boundary

This note audits the twelve entries that remain `unsupported` in the 194-entry
observed catalog. It is a v3 plan, not an implementation claim. It intentionally
does not edit the frozen 182-class catalog, executable registry, model label
order, rule IDs, or training protocol.

No rule in this document may enter the executable catalog merely because a
defensible interpretation is described below. Registration requires the
rule-specific evidence decisions, architecture work, tests, and replay fixture
listed here. Every newly executable rule starts as `implemented-unverified`.

## Evidence reviewed

The evidence hierarchy for this audit is:

1. The attributable
   [Chess.com community glossary](https://www.chess.com/forum/view/general/all-drawbacks)
   compiled by Truc1231 on 2024-06-18 and 2024-06-28.
2. The pinned
   [InvalidSE/DrawbackDetector observation corpus](https://raw.githubusercontent.com/InvalidSE/DrawbackDetector/9c8d298c8af911a8c92b3cedc7ff37a7ca6cad82/drawbacks.json),
   which contains 819 title/description observations copied from actual
   drawbackchess.com games.
3. Existing repository architecture decisions:
   `variant-move-authority.md`, `player-observation-policy.md`,
   `evaluator-turn-constraints.md`, and `docs/rules/loss/README.md`.

Neither external source is an official executable specification. The detector
repository does not implement these rules: `Detect_Drawback.py` contains only a
stub, and `Analyse_Drawbacks.py` groups descriptions and counts frequencies.
Its value is corroborating exact displayed text and observed parameter values,
not resolving game mechanics.

The pinned corpus corroborates seven rules:

| Rule | Observations | Distinct observed parameter text |
| --- | ---: | --- |
| Crusade | 4 | move 13/C6 twice; move 16/C3; move 16/F3 |
| Femme Fatale | 3 | no parameter |
| Glorious Battle | 5 | move 14 twice; move 15 three times |
| Nurturer | 8 | no parameter |
| Secret Garden | 8 | parameter values omitted from copied text |
| Triple Play | 7 | three bishops twice; three knights five times |
| You Best Not Miss | 3 | no parameter |

The remaining five—Death Wish, Devil on Your Shoulder, Fog of War, Inching
Forward, and Unlucky—have only the community glossary evidence. The apparent
count difference is material: the detector corpus adds no site-observation
evidence for those five.

## Audit result

None is safe to register now. Their confidence and primary prerequisites are:

- **Crusade:** medium after parameter-domain evidence; needs a
  resulting-position filter and deadline state.
- **Death Wish:** medium-low; needs the capturable-king authority.
- **Devil on Your Shoulder:** insufficient; needs a versioned suggestion
  provider after its semantics are sourced.
- **Femme Fatale:** high after the capturable-king authority exists.
- **Fog of War:** insufficient; needs the player-scoped observation security
  boundary and more evidence.
- **Glorious Battle:** high after start-move domain and timing evidence; needs a
  windowed forced-capture/loss rule.
- **Inching Forward:** insufficient; needs an evidenced deadline/checkpoint
  predicate.
- **Nurturer:** high after the capturable-king authority and promotion-history
  support exist.
- **Secret Garden:** medium after hidden-parameter evidence; needs a
  cross-player hidden terrain/loss event.
- **Triple Play:** medium after piece-domain evidence; needs the
  capturable-king authority.
- **Unlucky:** medium-low after subset-generation evidence; needs a per-turn
  hidden 32-square mask.
- **You Best Not Miss:** high after the capturable-king authority and delayed
  obligation support exist.

Strictly interpreted, none can be registered now without either inventing a
source behavior or silently approximating the source site's capturable-king
game. Three rules—Femme Fatale, Nurturer, and You Best Not Miss—have sufficiently
clear rule logic to implement immediately after the already-designed
capturable-king authority exists. Glorious Battle is similarly straightforward
after its parameter domain and move-count convention are evidenced.

## Shared v3 contracts

### Turn numbering

Every timed parameter must be named `startAffectedTurn`, not `moveNumber`,
unless captured site evidence proves that the displayed number is the FEN
fullmove number. State stores `affectedMovesApplied`, reconstructed by counting
history moves of the affected color. An active four-turn window is:

```text
startAffectedTurn <= affectedMovesApplied + 1 <= startAffectedTurn + 3
```

This convention is deliberately provisional for Crusade and Glorious Battle.
Their site text says “move,” while existing observations do not distinguish
White and Black timing. Production parameter generation stays disabled until
that distinction is resolved.

### Variant move authority

Death Wish, Femme Fatale, Nurturer, Triple Play, and You Best Not Miss must use
the `capturable-king/v1` authority specified in
`docs/architecture/variant-move-authority.md`. A check, checkmate, SAN suffix,
or ordinary `chess.js` move is never a substitute for a move with
`terminalIntent: "capture-king"`.

Rules may remove or force authority-generated moves. They may not manufacture a
move. King capture terminates immediately before the next start-of-turn loss.
Stockfish-backed agents and evaluations fail closed once a position is not
orthodox.

### Resulting-position predicates

Crusade and Secret Garden need an engine-owned pure preview operation:

```ts
previewMove(position, moveId, capabilities): SerializedAuthorityPosition
```

Rules must not create a second board mutator. The preview must use the same
authority and capability request as final application and must be deterministic
and side-effect free.

### Parameters and random generation

Hidden parameters are sampled once before `initialize`; rerandomized turn masks
derive from a single sampled uint32 seed plus the affected-turn index. Parameter
domains are versioned catalog data. Do not infer a complete domain or frequency
distribution from the small detector sample.

## Rule specifications and blockers

### Crusade

Source: “For four consecutive moves, starting on move (random number), you must
end your turn occupying (random square).”

Proposed parameters, after domain evidence:

```ts
interface CrusadeParameters {
  readonly startAffectedTurn: number;
  readonly targetSquare: Square;
}

interface CrusadeState {
  readonly affectedMovesApplied: number;
}
```

Defensible executable interpretation: during each of the four affected turns,
retain exactly moves whose resulting position contains at least one affected
player piece on `targetSquare`. The occupying piece need not be the mover. If a
piece already occupies the square, moving another piece remains legal; moving
the sole occupant away is forbidden unless the complete move replaces it with
another own piece. If no authority move satisfies the predicate, the player
loses before moving through the generic zero-filter loss.

Unresolved evidence:

- whether “move N” is an affected turn or FEN fullmove;
- the complete start-turn and target-square domains;
- whether “occupying” means any own piece or specifically the moved piece;
- whether the four turns are inclusive exactly as proposed;
- whether an opponent already occupying the square makes the obligation
  immediately impossible.

Do not generate only the observed `{13, 16}` or
`{c3, f3, c6}` values; those are samples, not a declared domain.

Tests: both colors and turn boundaries N-1/N/N+3/N+4; enter, remain, replace,
and leave target; opponent occupies target; multiple satisfying moves; no
satisfying move; castling preview including rook occupancy; en-passant removal;
all four promotion choices; immutable input; replay fixture with four successes
and one failure branch; predictor particles for every declared parameter.

### Death Wish

Source: “If you can move your king into check (and aren't already in check),
you must.”

Parameters: `{}`. State needs only `affectedMovesApplied` for diagnostics.
Authority requirement:

```ts
{
  authorityFamily: "capturable-king",
  capabilities: ["king-may-enter-attack"]
}
```

Proposed filtering follows the existing authority design: if the affected king
is not currently attacked and one or more capability-marked king moves enter an
attacked square, retain all such moves and no ordinary alternatives. If already
attacked, preserve the authority's normal check-evasion set. No pinned
non-king move becomes legal. Castling remains governed by normal attack
restrictions.

Unresolved evidence:

- whether an exposed king may survive when the opponent declines capture;
- whether the opponent is forced to capture an exposed king;
- the source site's attack definition for pinned pieces and king adjacency;
- whether castling can ever satisfy the rule;
- whether “already in check” refers to check state at turn start only.

Tests are the complete Death Wish matrix already listed in
`variant-move-authority.md`, plus symmetric combinations with every literal
king-capture rule.

### Devil on Your Shoulder

Source: “A devil is suggesting terrible moves for you to make. If you disobey
it 7 turns in a row, you must obey in the 8th.”

No executable interpretation is justified. Missing semantics include the
suggestion generator, one move versus a set, legality, disclosure, obedience
identity, counter reset, affected-turn timing, and unavailable suggestions.
Stockfish's worst move is not implied by the source.

If source evidence later defines a deterministic external provider, use:

```ts
interface DevilParameters {
  readonly policyId: string;
}

interface DevilState {
  readonly consecutiveDisobedience: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
}
```

The provider output must be a public per-turn fact, content-addressed by policy,
position, root mask, and provider fingerprint. On the eighth affected turn,
filter to the suggested legal move set or return a rule-defined loss. Reuse the
asynchronous external-constraint orchestration; do not make `DrawbackRule`
asynchronous.

Tests after clarification: obey on turns 1–7 resets; seven disobediences force
turn eight; suggestion changes and ties; suggested capture, castle, en-passant,
promotion; only-legal-move; unavailable suggestion; cancellation/cache/worker
determinism; predictor unevaluable state when provider evidence is absent.

### Femme Fatale

Source: “You can only capture their king with a queen.”

Parameters/state: `{}` plus diagnostic move count. Authority requirement is
`capturable-king` with `enemy-king-capture`, but not
`king-may-enter-attack`.

Exact filter: reject a move with `terminalIntent: "capture-king"` unless the
primary mover's pre-move type is `queen`; preserve every other authority move.
A pawn promoting to queen while capturing the king is a pawn mover and is
rejected unless site evidence says resulting type controls. A promoted queen on
a later turn is a queen and qualifies.

Tests: queen king-capture allowed; all other current types rejected; promoted
queen on later turn; capture-and-promote edge; ordinary queen captures;
queen check/checkmate without capture; discovered check; castling and en
passant; no king-capture available; immediate terminal precedence; both colors.

### Fog of War

Source: “You can't see your opponent's pieces (you can still see when a possible
move is a capture or a king capture, though, and you know when you're in
check).”

This is an observation rule, not a legal-move filter. Its full prerequisite is
the versioned `PlayerObservationV1`, opaque action tokens, evidence-gap-aware
predictor, observed-square web board, principal-scoped replay, agent
capabilities, and leakage gates in `player-observation-policy.md`.

No parameters are evidenced. The rule still cannot be specified exactly:

- whether empty enemy-side squares are visibly empty;
- what opponent move geometry/history is shown;
- whether “king capture” means capture of the opposing king or capture by a
  king;
- what is revealed for castling, en passant, and promotion;
- whether opponent pieces become visible while attacking or adjacent;
- whether capture targets reveal type, color, or only the capture affordance.

The conservative projection in the architecture document is safe as a security
boundary but is not evidence that it matches the game. Keep the rule
unsupported until recorded site interaction resolves each item.

Tests: all leakage, observational-equivalence, action-token, agent-spy, replay,
DOM, accessibility-tree, network, log, and predictor-unknown-mask tests listed
in the architecture document. Add browser recordings for quiet move, capture,
check, castle, en-passant opportunity, and promotion.

### Glorious Battle

Source: “For four consecutive moves, starting on move (random number), you must
capture (or lose).” The corpus observed starts 14 and 15.

Proposed parameters/state:

```ts
interface GloriousBattleParameters {
  readonly startAffectedTurn: number;
}

interface GloriousBattleState {
  readonly affectedMovesApplied: number;
}
```

During the four-turn window, return only capture moves. If none exists, return
an explicit `DrawbackLoss` before the move rather than relying only on a generic
“all moves forbidden” message. Outside the window preserve all moves. En
passant and capturing promotions count; castling and quiet promotion do not.

Unresolved evidence: full start-turn domain, affected-turn versus FEN fullmove,
inclusive boundary, and whether “or lose” applies immediately when no capture
exists or after choosing a quiet move. The current engine rejects illegal
choices rather than accepting them and then losing, so this distinction matters
for replay compatibility.

Tests: N-1/N/N+3/N+4 boundaries for both colors; capture available versus none;
multiple captures; en passant; capture promotion; quiet promotion; castling;
already checkmated/stalemated precedence; explicit loss reason; predictor
elimination and parameter particles.

### Inching Forward

Source: “After move 6, your king must be in front of your home rank. Every six
moves after, the rank it must be moves forward by one.”

Parameters: `{}`. Candidate state is `{ affectedMovesApplied: number }`, but no
predicate should be coded yet. At least three materially different readings fit
the text:

1. checkpoint minimum: at turns 7, 13, 19, ... the king's rank must be at least
   2, 3, 4, ... relative to home;
2. continuous minimum: from each checkpoint onward every resulting position
   must remain at or beyond the threshold;
3. exact-rank deadline: the king must occupy exactly the named rank at each
   checkpoint.

It is also unknown whether “after move 6” checks the resulting position of move
6 or the start of move 7, and what happens after the threshold passes rank 8.
The repository loss-rule documentation correctly keeps it unsupported.

Tests after clarification: both colors at every boundary; ahead/equal/behind;
retreat between checkpoints; king captured/missing under variant authority;
rank-eight saturation or terminal; castling at a checkpoint; check-constrained
positions; replay from before and after each deadline.

### Nurturer

Source: “You can't capture their king until you've promoted a pawn.”

Parameters: `{}`.

```ts
interface NurturerState {
  readonly hasPromotedPawn: boolean;
}
```

The state becomes true after any affected-player move whose pre-move type is
`pawn` and which has a promotion field, including capture promotion. It never
resets if that promoted piece is captured. Before it becomes true, reject only
`terminalIntent: "capture-king"`; afterward preserve it. Initialization from
midgame history reconstructs the flag or fails closed when history is
incomplete.

Tests: king capture before/after quiet promotion and capture promotion; every
promotion type; promoted piece later captured; opponent promotion does not
unlock; a preloaded promoted piece without history is not silently accepted;
check/checkmate is not king capture; immediate terminal; both colors.

### Secret Garden

Source: “You have a secret garden in front of (two of) your pawns. You can't
move onto it, and if your opponent tramples it (moves onto it), you lose.”

Likely parameters, pending evidence:

```ts
interface SecretGardenParameters {
  readonly gardenSquares: readonly [Square, Square];
}
```

The most defensible interpretation fixes two distinct squares at initialization,
each one step forward from two distinct affected-player pawns then present.
Affected-player moves ending on either garden square are forbidden. If the
opponent's last primary destination is a garden square, the affected player
loses at the start of their turn. The squares remain fixed if the associated
pawn moves or is captured. The opponent must not receive them through its agent
view, predictor input, or live UI.

That interpretation is not yet safe to register. Evidence must resolve whether
there are always exactly two gardens, how pawns/squares are selected, whether
the affected player may pass through a garden, whether an opponent trampling
ends immediately or next turn, and whether castling's rook destination counts.
The detector's copied descriptions omit the actual hidden square values.

Tests: deterministic distinct selection for both colors; only squares directly
ahead of eligible pawns; own landing forbidden; own pass-through and castling;
opponent primary landing loss; opponent castling auxiliary rook; en-passant;
promotion; garden remains after pawn movement/capture; occupied garden at
initialization; cross-color secrecy; exact replay and predictor parameter
particles.

### Triple Play

Source: “You can only capture their king if you have three (random piece).” The
corpus observed bishops and knights only.

Proposed parameters:

```ts
interface TriplePlayParameters {
  readonly requiredType: PieceType;
}
```

Exact filter after the domain is known: admit `capture-king` only when the
affected player's current resulting-or-pre-move material (source evidence must
choose one) contains at least three pieces of `requiredType`. Preserve all
non-king-captures. “Have three” is interpreted as at least three, not exactly
three, only after evidence confirmation. Promoted pieces count as their current
type under project conventions.

Unresolved evidence: parameter domain—observations prove bishop and knight but
not pawn/rook/queen/king; exactly versus at least three; whether the capturing
move's resulting board controls; whether the capturing piece itself counts;
how a capturing promotion is typed.

Tests: 0/1/2/3/4 required pieces; both observed types and every confirmed domain
type; promoted members; member captured immediately before opportunity;
capturing mover counted; capture promotion; ordinary captures and checks;
immediate king-capture terminal; parameter-particle normalization.

### Unlucky

Source: “Can't move to half of squares, re-randomized every move.”

Likely parameters/state:

```ts
interface UnluckyParameters {
  readonly seed: number;
}

interface UnluckyState {
  readonly affectedMovesApplied: number;
  readonly forbiddenSquares: readonly Square[]; // exactly 32, canonical order
}
```

A platform interpretation can derive a deterministic 32-of-64 subset without
replacement from `(seed, affectedMovesApplied, domainTag)`, filter by primary
destination, and disclose the current forbidden set only to the affected
player. That is not yet a recreation of evidenced behavior.

Missing evidence: uniform subset versus a structured half-board mask; whether
the mask rerandomizes before or after an affected move; whether origin squares
or paths matter; visibility of the mask; whether at least one legal move is
guaranteed; and whether duplicate/weighted selection is possible. Colorblind's
two color classes do not establish Unlucky's mechanism.

Tests after clarification: exactly 32 unique sorted squares each turn; fixed
seed reproducibility; turn-to-turn change; worker-count parity; destination
filter for castle, en-passant, and all promotions; origin/path non-effects;
empty legal mask/loss behavior; player-only disclosure; predictor reconstructs
the same mask from a seed particle without learning the true seed.

### You Best Not Miss

Source: “If you end your turn checking your opponent, you must capture their
king on the next move (or lose).”

Parameters: `{}`.

```ts
interface YouBestNotMissState {
  readonly mustCaptureKingNextTurn: boolean;
}
```

After an affected-player move, set the flag from the authority's resulting
attack state against the opponent king. At the affected player's next turn, if
the flag is set, retain only moves with `terminalIntent: "capture-king"`. If no
such move exists, return the rule-specific loss before moving. A successful
king capture terminates immediately. If the opponent captured the affected
king first, that terminal result already ended the game.

Do not infer the trigger from SAN alone. The authority must distinguish a
present attacked king from checkmate and captured-king terminal state.

Residual evidence questions: whether any check triggers or only a check that
could be converted on the next turn; whether the obligation persists if the
opponent escapes all king captures; and whether “next move” means next affected
turn. The wording strongly supports the proposed delayed obligation, but a site
replay should confirm it.

Tests: quiet/capture/discovered/promotion check trigger; non-check no trigger;
opponent removes every king-capture opportunity; one/multiple terminal moves;
checkmate is not a surrogate; castling check; en-passant discovered check;
opponent captures affected king; immediate terminal precedence; state and
predictor isolation by color.

## Implementation order

### Phase A: evidence capture without catalog changes

1. Add a browser/replay evidence form recording rule title, exact displayed
   parameter text, affected color, initial disclosure, every board/action
   observation, result timing, and source URL or immutable artifact hash.
2. Target parameter-rich games first: Crusade, Glorious Battle, Secret Garden,
   Triple Play, and Unlucky.
3. Record controlled edge cases for Inching Forward, Death Wish, Fog of War,
   Devil on Your Shoulder, and You Best Not Miss.
4. Store raw evidence outside generated training data and write a sourced rule
   decision before changing status.

### Phase B: capturable-king authority

Implement and differentially test `standard-chess/v1` and
`capturable-king/v1` exactly as designed. Migrate session, predictor, probe,
simulation, fixtures, dataset schema, worker protocol, replay, UI, and
post-game analysis before registering a variant rule.

Then implement, in order:

1. Femme Fatale;
2. Nurturer;
3. You Best Not Miss;
4. Triple Play after its parameter domain is known;
5. Death Wish after exposed-king behavior is known.

### Phase C: standard-authority timed and terrain rules

After evidence decisions, add a reusable affected-turn window helper and
authority preview predicate. Implement:

1. Glorious Battle;
2. Crusade;
3. Secret Garden;
4. Unlucky;
5. Inching Forward.

Secret Garden and Unlucky additionally require principal-scoped parameter
disclosure and secrecy tests.

### Phase D: observation and external-provider rules

Implement the player observation boundary before Fog of War. Implement a
suggestion provider only after Devil semantics identify what the provider is.
These are separate capabilities and should not be hidden inside ordinary rule
filters.

## Catalog and model migration

The frozen v2 model remains a 182-class artifact. V3 must use:

- a new catalog schema/version and canonical label-order hash;
- new simulator engine identity and dataset schema;
- fresh train/validation/test corpora;
- model heads sized to the exact new executable class count;
- explicit unsupported-hypothesis handling when live text names a rule absent
  from the loaded model;
- no remapping of old logits by array position;
- a v2-to-v3 compatibility report keyed by stable drawback ID.

Registration of one rule is a model protocol change even if its TypeScript
implementation is isolated. Never append classes to a released model manifest
in place.

## Release gate per rule

Before status changes from `unsupported`:

1. attributable rule decision with every ambiguity answered;
2. exact parameter schema and evidenced generation domain;
3. positive, negative, boundary, both-color, immutable-filter, replay, and
   predictor tests;
4. promotion, castling, and en-passant tests when mechanically relevant;
5. start-of-turn and terminal-precedence tests when relevant;
6. sync/async simulation determinism and worker parity;
7. no unrestricted fallback when a required authority/provider/view is absent;
8. one normal-operation replay fixture and one failure fixture;
9. catalog regeneration and identity review;
10. complete v3 corpus regeneration, training, calibration, and sealed
    evaluation under new manifests.

Only official text or reproducible source-site behavior sufficient to satisfy
the repository's full verification policy may advance a rule from
`implemented-unverified` to `verified`.
