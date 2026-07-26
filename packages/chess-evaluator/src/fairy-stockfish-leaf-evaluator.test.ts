import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  join,
  resolve,
} from "node:path";
import { describe, expect, it } from "vitest";
import {
  UnsupportedDrawbackLeafPositionError,
  type LeafPosition,
} from "@drawbackengine/drawback-search";
import { UciClient } from "./client.js";
import {
  DRAWBACKCHESS_FAIRY_VARIANT_SHA256,
  initializeFairyStockfishLeafEvaluator,
} from "./fairy-stockfish-leaf-evaluator.js";
import { MockUciTransport } from "./mock-transport.js";

const FEN = "4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1";
const VARIANT_PATH = resolve("data/catalog/drawbackchess-fairy-v1.ini");

function leaf(): LeafPosition {
  return {
    authorityId: "capturable-king/v1",
    fen: FEN,
    turn: "white",
    legalMoves: [
      {
        from: "e1",
        to: "e2",
        color: "white",
        piece: "king",
        san: "Ke2",
        flags: "quiet",
      },
      {
        from: "e2",
        to: "a2",
        color: "white",
        piece: "rook",
        san: "Ra2",
        flags: "quiet",
      },
    ],
    history: [],
    orthodoxCompatible: false,
    kingPassantActive: false,
  };
}

function rootAt(
  position: LeafPosition,
  index: number,
): LeafPosition["legalMoves"][number] {
  const move = position.legalMoves[index];
  if (move === undefined) {
    throw new Error(`Missing test root at index ${String(index)}.`);
  }
  return move;
}

function handshake() {
  return [
    {
      command: "uci",
      responses: [
        "id name Fairy-Stockfish Test",
        "option name Clear Hash type button",
        "option name VariantPath type string default <empty>",
        "option name UCI_Variant type combo default chess var chess var drawbackchess",
        "uciok",
      ],
    },
    { command: "isready", responses: ["readyok"] },
    {
      command: /^setoption name VariantPath value .+[\\/]drawbackchess\.ini$/u,
    },
    {
      command: "setoption name UCI_Variant value drawbackchess",
    },
    { command: "isready", responses: ["readyok"] },
  ] as const;
}

async function initializedClient(
  steps: ConstructorParameters<typeof MockUciTransport>[0],
  depth = 3,
): Promise<{
  client: UciClient;
  evaluator: Awaited<
    ReturnType<typeof initializeFairyStockfishLeafEvaluator>
  >;
  transport: MockUciTransport;
}> {
  const transport = new MockUciTransport(steps);
  const client = new UciClient(transport);
  const evaluator = await initializeFairyStockfishLeafEvaluator({
    client,
    depth,
    variantPath: VARIANT_PATH,
  });
  return { client, evaluator, transport };
}

describe("initializeFairyStockfishLeafEvaluator", () => {
  it("pins the checked-in custom variant bytes", async () => {
    const bytes = await readFile(VARIANT_PATH);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      DRAWBACKCHESS_FAIRY_VARIANT_SHA256,
    );
    const client = new UciClient(new MockUciTransport([]));
    await expect(initializeFairyStockfishLeafEvaluator({
      client,
      depth: 3,
      variantPath: resolve("package.json"),
    })).rejects.toThrow("do not match the pinned digest");
  });

  it("loads a private copy even if the caller source has an ABA change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drawbackengine-fairy-"));
    const variantPath = join(directory, "drawbackchess.ini");
    await copyFile(VARIANT_PATH, variantPath);
    const canonicalBytes = await readFile(variantPath);
    let loadedPath = "";
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: [
          "id name Fairy-Stockfish Test",
          "option name VariantPath type string default <empty>",
          "option name UCI_Variant type combo default chess var chess var drawbackchess",
          "uciok",
        ],
      },
      { command: "isready", responses: ["readyok"] },
      {
        command: /^setoption name VariantPath value (.+)$/u,
        onSend: async function () {
          const command = transport.commands.at(-1) ?? "";
          loadedPath = command.slice(
            "setoption name VariantPath value ".length,
          );
          await writeFile(variantPath, "[changed:chess]\nchecking = true\n");
          await writeFile(variantPath, canonicalBytes);
        },
      },
      { command: "setoption name UCI_Variant value drawbackchess" },
      { command: "isready", responses: ["readyok"] },
      { command: "quit" },
    ]);
    const client = new UciClient(transport);
    try {
      const evaluator = await initializeFairyStockfishLeafEvaluator({
        client,
        depth: 3,
        variantPath,
      });
      expect(resolve(loadedPath)).not.toBe(resolve(variantPath));
      await evaluator.close();
      expect(transport.complete).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a variant file reached through a parent directory link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "drawbackengine-link-"));
    const targetDirectory = join(directory, "target");
    const linkedDirectory = join(directory, "linked");
    await mkdir(targetDirectory);
    await copyFile(
      VARIANT_PATH,
      join(targetDirectory, "drawbackchess.ini"),
    );
    await symlink(
      targetDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const transport = new MockUciTransport([]);
    const client = new UciClient(transport);
    try {
      await expect(initializeFairyStockfishLeafEvaluator({
        client,
        depth: 3,
        variantPath: join(linkedDirectory, "drawbackchess.ini"),
      })).rejects.toThrow("cannot traverse a symbolic link");
      expect(transport.complete).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic link to the variant file",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "drawbackengine-link-"));
      const variantPath = join(directory, "drawbackchess.ini");
      await symlink(VARIANT_PATH, variantPath, "file");
      const client = new UciClient(new MockUciTransport([]));
      try {
        await expect(initializeFairyStockfishLeafEvaluator({
          client,
          depth: 3,
          variantPath,
        })).rejects.toThrow("regular non-symlink file");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("loads the custom variant and searches the exact synthetic root mask", async () => {
    const { evaluator, transport } = await initializedClient([
      ...handshake(),
      { command: "ucinewgame" },
      { command: "setoption name Clear Hash" },
      { command: "isready", responses: ["readyok"] },
      { command: `position fen ${FEN}` },
      {
        command: "go depth 6 searchmoves e1e2 e2a2",
        responses: [
          "info depth 6 score cp 37 pv e1e2 e8e2",
          "bestmove e1e2",
        ],
      },
      { command: "quit" },
    ], 6);

    await expect(evaluator.evaluate(leaf())).resolves.toBe(37);
    await evaluator.close();
    expect(transport.complete).toBe(true);
  });

  it("passes a castling root when no king-passant right is active yet", async () => {
    const fen = "5r1k/8/8/8/8/8/8/4K2R w K - 0 1";
    const { evaluator, transport } = await initializedClient([
      ...handshake(),
      { command: "ucinewgame" },
      { command: "setoption name Clear Hash" },
      { command: "isready", responses: ["readyok"] },
      { command: `position fen ${fen}` },
      {
        command: "go depth 3 searchmoves e1g1",
        responses: [
          "info depth 3 score cp -80 pv e1g1 f8f1",
          "bestmove e1g1",
        ],
      },
      { command: "quit" },
    ]);

    await expect(evaluator.evaluate({
      ...leaf(),
      fen,
      legalMoves: [{
        from: "e1",
        to: "g1",
        color: "white",
        piece: "king",
        san: "O-O",
        flags: "quiet,kingside-castle",
      }],
    })).resolves.toBe(-80);
    await evaluator.close();
    expect(transport.complete).toBe(true);
  });

  it("fails before UCI for empty, duplicate, and active king-passant roots", async () => {
    const { evaluator, transport } =
      await initializedClient([...handshake(), { command: "quit" }], 4);
    const base = leaf();
    await expect(evaluator.evaluate({
      ...base,
      legalMoves: [],
    })).rejects.toThrow("non-empty");
    await expect(evaluator.evaluate({
      ...base,
      legalMoves: [rootAt(base, 0), rootAt(base, 0)],
    })).rejects.toThrow("duplicate");
    const activeKingPassant = evaluator.evaluate({
      ...base,
      kingPassantActive: true,
    });
    await expect(activeKingPassant).rejects.toThrow(
      "active castling king-en-passant",
    );
    await expect(activeKingPassant).rejects.toBeInstanceOf(
      UnsupportedDrawbackLeafPositionError,
    );
    await evaluator.close();
    expect(transport.commands).toEqual([
      "uci",
      "isready",
      expect.stringMatching(
        /^setoption name VariantPath value .+[\\/]drawbackchess\.ini$/u,
      ),
      "setoption name UCI_Variant value drawbackchess",
      "isready",
      "quit",
    ]);
  });

  it.each(["lowerbound", "upperbound"] as const)(
    "rejects a non-exact %s score",
    async (bound) => {
      const { evaluator } = await initializedClient([
        ...handshake(),
        { command: "ucinewgame" },
        { command: "setoption name Clear Hash" },
        { command: "isready", responses: ["readyok"] },
        { command: `position fen ${FEN}` },
        {
          command: "go depth 5 searchmoves e1e2 e2a2",
          responses: [
            `info depth 5 score cp 12 ${bound} pv e1e2`,
            "bestmove e1e2",
          ],
          },
          { command: "quit" },
      ], 5);
      const pending = evaluator.evaluate(leaf());
      await expect(pending).rejects.toThrow(
        "did not return an exact score",
      );
      await expect(pending).rejects.not.toBeInstanceOf(
        UnsupportedDrawbackLeafPositionError,
      );
      await evaluator.close();
    },
  );

  it("serializes reset and search on the borrowed client", async () => {
    const search = (score: number) => [
      { command: "ucinewgame" },
      { command: "setoption name Clear Hash" },
      { command: "isready", responses: ["readyok"] },
      { command: `position fen ${FEN}` },
      {
        command: "go depth 3 searchmoves e1e2 e2a2",
        responses: [
          `info depth 3 score cp ${String(score)} pv e1e2`,
          "bestmove e1e2",
        ],
      },
    ] as const;
    const { evaluator, transport } = await initializedClient([
      ...handshake(),
      ...search(9),
      ...search(-4),
      { command: "quit" },
    ]);

    await expect(
      Promise.all([evaluator.evaluate(leaf()), evaluator.evaluate(leaf())]),
    ).resolves.toEqual([9, -4]);
    await evaluator.close();
    expect(transport.complete).toBe(true);
  });

  it("requires a client advertising the Fairy variant options", async () => {
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: ["id name Ordinary Stockfish", "uciok"],
      },
      { command: "isready", responses: ["readyok"] },
      { command: "quit" },
    ]);
    const client = new UciClient(transport);
    await expect(initializeFairyStockfishLeafEvaluator({
      client,
      depth: 3,
      variantPath: VARIANT_PATH,
    })).rejects.toThrow("does not advertise VariantPath");
    expect(transport.complete).toBe(true);
  });

  it("requires an uninitialized client", async () => {
    const transport = new MockUciTransport([
      {
        command: "uci",
        responses: [
          "id name Fairy-Stockfish Test",
          "uciok",
        ],
      },
      { command: "isready", responses: ["readyok"] },
      { command: "quit" },
    ]);
    const client = new UciClient(transport);
    await client.initialize();

    await expect(initializeFairyStockfishLeafEvaluator({
      client,
      depth: 3,
      variantPath: VARIANT_PATH,
    })).rejects.toThrow("already initialized");
    expect(transport.complete).toBe(true);
  });

  it("treats use after close as an operational failure", async () => {
    const { evaluator, transport } = await initializedClient([
      ...handshake(),
      { command: "quit" },
    ]);
    await evaluator.close();

    const pending = evaluator.evaluate(leaf());
    await expect(pending).rejects.toThrow("leaf evaluator is closed");
    await expect(pending).rejects.not.toBeInstanceOf(
      UnsupportedDrawbackLeafPositionError,
    );
    expect(transport.complete).toBe(true);
  });
});
