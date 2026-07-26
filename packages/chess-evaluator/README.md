# Chess evaluator

`@drawbackengine/chess-evaluator` is a transport-oriented UCI client for local
analysis engines such as Stockfish. It does not download, bundle, or license an
engine binary. Callers are responsible for their engine installation and may
provide a custom transport or use the explicit Node process transport.

## Transport contract

A transport writes complete UCI command lines and exposes one ordered
`AsyncIterable<string>` of complete response lines:

```ts
interface UciTransport {
  send(command: string): Promise<void>;
  lines(): AsyncIterable<string>;
  close(): Promise<void>;
}
```

This boundary works with a Node child process, Web Worker, WebAssembly adapter,
socket, or test double. The adapter must preserve line order, must not include
newline delimiters in yielded values, and must end its iterator when the engine
exits.

Only one `UciClient` may consume a transport. Searches are deliberately
serialized because UCI uses a single command/response stream.

For Node, `NodeProcessUciTransport` launches a caller-supplied executable
directly with `shell: false`, parses stdout into ordered lines, bounds retained
stderr, and terminates a process that ignores shutdown:

```ts
const transport = new NodeProcessUciTransport({
  executablePath: "/path/to/stockfish",
});
```

## Lifecycle

```ts
import { UciClient } from "@drawbackengine/chess-evaluator";

const client = new UciClient(yourTransport, { timeoutMs: 10_000 });
const identity = await client.initialize(); // uci -> uciok -> isready -> readyok

await client.newGame(); // ucinewgame -> isready -> readyok
const evaluation = await client.evaluateFen(
  fen,
  { depth: 14 },
  ["e2e4", "d2d4"], // optional exact root-move mask
);

await client.close(); // quit, then transport shutdown
```

Search limits support depth, node count, or move time. An evaluation resolves
only after `bestmove`; an ended stream or timeout is an explicit error. Scores
are exactly as reported by UCI and are relative to the side to move in the
supplied FEN:

- `centipawns`: signed pawn fractions (`100` is approximately one pawn)
- `mate`: signed moves to mate
- `lower` / `upper`: bound markers from the engine

No score is silently converted to White's perspective.

## Testing without Stockfish

`MockUciTransport` uses an exact command script and deterministic response
lines. Unexpected or out-of-order commands fail immediately:

```ts
const transport = new MockUciTransport([
  { command: "uci", responses: ["id name Test", "uciok"] },
  { command: "isready", responses: ["readyok"] },
]);
```

The package tests cover handshake order, readiness barriers, centipawn and mate
scores, bounds, terminal positions, stream termination, timeouts, malformed
responses, command validation, and concurrent-search rejection.

## Optional Fairy-Stockfish heuristic

`initializeFairyStockfishLeafEvaluator` can rank leaves from the exact
DrawbackEngine outer search with a separately installed, pinned
Fairy-Stockfish binary. Pass an uninitialized borrowed client so configuration
authentication and engine loading happen as one operation:

```ts
const client = new UciClient(transport);
const evaluator = await initializeFairyStockfishLeafEvaluator({
  client,
  depth: 8,
  variantPath: "data/catalog/drawbackchess-fairy-v1.ini",
});

// The evaluator owns the borrowed client after successful initialization.
await evaluator.close();
```

Initialization hashes the exact regular, non-symlink source file, copies those
authenticated bytes to a private read-only session path, and loads only that
copy behind a UCI readiness barrier. The private artifact is retained until
`close()` and then removed. Changing or replacing the caller's source path
during loading cannot change the bytes Fairy receives. The versioned
configuration uses Fairy-Stockfish's official custom-variant
contract: `VariantPath` loads the file, `UCI_Variant=drawbackchess` selects it,
`checking=false` makes the king capturable and disables check restrictions,
king extinction is a loss, and having no moves is a loss. Validate the file
against the exact binary before use:

```text
fairy-stockfish check data/catalog/drawbackchess-fairy-v1.ini
```

This is not a second rules authority and does not establish engine parity.
DrawbackEngine's outer search still owns both hidden drawbacks, exact move
filters, rule state, king-capture precedence, and every real transition.
Fairy-Stockfish supplies only a heuristic score below the exact outer depth
and receives the complete exact root mask.

The custom format does not express Drawback Chess's one-reply castling
king-en-passant state. The exact outer search passes that public ephemeral flag
separately, and the adapter fails closed while it is active. Fairy-Stockfish can
otherwise evaluate castling roots with `checking=false`; future castling inside
its heuristic continuation still lacks the site's special response. Do not
infer the right from FEN, and do not claim exact parity until a pinned real
binary passes differential move and score validation against the
DrawbackEngine authority.

The artifact boundary protects against caller-path replacement and accidental
concurrent writes. It is not a sandbox against a malicious process running as
the same operating-system principal with permission to inspect and alter this
process's private temporary directory.
