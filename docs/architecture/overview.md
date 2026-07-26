# Architecture

## Boundaries

The engine is a framework-agnostic TypeScript library. React can submit commands and render sanitized projections, but it never decides legality. Standard chess legality is owned by `chess.js`; drawback rules receive immutable normalized moves and may only narrow that move set unless their catalog family explicitly declares a movement transformation.

Each `GameSession` owns two separate rule instances:

- White state and parameters are accessible only while evaluating White's rule.
- Black state and parameters are accessible only while evaluating Black's rule.
- Public snapshots contain rule identifiers only when an explicit reveal policy permits them.
- Predictor inputs contain observed positions and moves, never true rule state or hidden parameters.

`GameSession.exportSecretSnapshot()` is a deliberately trusted, engine-only
capability for simulation labels and post-game reveal. It returns a defensive
clone and is never called while constructing an `AgentView` or
`MoveObservation`. Simulation captures the active player's snapshot immediately
before each move, so a dataset row records the parameters and internal state
that actually constrained that decision. Feature generation treats those
fields as labels and rejects them as model inputs.

## Turn sequence

For an accepted move the engine:

1. Generates ordinary legal chess moves.
2. Applies the active player's drawback filter.
3. Rejects commands outside the filtered set.
4. Applies the standard chess move.
5. Updates only the active player's drawback state.
6. Switches turns.
7. Evaluates the new active player's start-of-turn drawback loss.
8. Evaluates standard chess ending conditions.
9. Emits an observation suitable for prediction updates.

The engine reports a drawback loss before a simultaneous standard ending because this order is part of the project contract. Rules may not mutate the ordinary legal-move array.

If standard chess supplies at least one legal move but the active drawback filters all of them, DrawbackEngine records a start-of-turn drawback loss. The observed game does not publicly specify this edge, so this is an explicit platform convention. If standard chess supplies no legal moves, ordinary checkmate or stalemate evaluation applies instead.

## Determinism

All random choices receive an injected `RandomSource`. The initial implementation uses Mulberry32 with an unsigned 32-bit seed. Catalog batches derive one seed per game, then independently select White and Black rules and agent profiles from stable ordered catalogs. Simulation records retain their seed, selected rules, generated parameters, active agent ID/style/strength, pre-move rule state, pre-move FEN, and normalized move.

## Rule verification

Catalog status is one of:

- `verified`: documented and covered by all applicable positive, negative, edge, promotion, castling, en-passant, loss, and replay tests.
- `implemented-unverified`: executable with tests, but at least one interpretation lacks authoritative evidence.
- `partial`: intentionally incomplete and never exposed as fully enforced.
- `unsupported`: metadata only; the engine refuses to instantiate it.

Rule metadata and executable implementations are separate so unsupported entries cannot silently behave like ordinary chess.

## Threat model

The game engine necessarily knows both drawbacks. Player views receive only their own secret. The predictor receives neither secret. Dataset writers are allowed to attach labels only after feature generation, preventing label fields from entering model inputs.
