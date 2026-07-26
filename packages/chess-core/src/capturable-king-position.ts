import { Chess as OrthodoxChess } from "chess.js";
import { pawnAttacks } from "chessops/attacks";
import {
  Castles,
  Chess,
  pseudoDests,
  type Context,
} from "chessops/chess";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import type { Setup } from "chessops/setup";
import { SquareSet } from "chessops/squareSet";
import type {
  CastlingSide,
  Color,
  NormalMove,
  Piece,
  Role,
  Square,
} from "chessops/types";
import {
  kingCastlesTo,
  makeSquare,
  parseSquare,
  rookCastlesTo,
} from "chessops/util";
import type {
  ChessMove,
  PromotionPiece,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";
import { sameMove } from "./move-adapter.js";
import type { MoveCommand } from "./game-session.js";

const PROMOTIONS: readonly PromotionPiece[] = [
  "queen",
  "rook",
  "bishop",
  "knight",
];

const PIECE_LETTER: Readonly<Record<Role, string>> = {
  pawn: "",
  knight: "N",
  bishop: "B",
  rook: "R",
  queen: "Q",
  king: "K",
};

interface KingPassantRight {
  readonly victim: PlayerColor;
  readonly kingSquare: Square;
  readonly targets: readonly Square[];
}

export interface CapturableKingPositionSnapshot {
  readonly format: "drawbackengine-public-position";
  readonly version: 1;
  readonly authorityId: "capturable-king/v1";
  readonly fen: string;
  readonly orthodoxCompatible: boolean;
  readonly kingPassant: {
    readonly victim: PlayerColor;
    readonly kingSquare: string;
    readonly targets: readonly string[];
  } | null;
  readonly terminal: CapturableKingTerminal;
}

interface GeneratedMove {
  readonly move: ChessMove;
  readonly operation: NormalMove;
  readonly castleSide?: CastlingSide;
  readonly kingPassant?: KingPassantRight;
}

export type CapturableKingTerminal =
  | {
      readonly kind: "king-capture";
      readonly winner: PlayerColor;
      readonly capturedKing: PlayerColor;
      readonly move: ChessMove;
      readonly method: "direct" | "castling-en-passant";
    }
  | null;

export interface CapturableKingMoveResult {
  readonly move: ChessMove;
  readonly terminal: CapturableKingTerminal;
}

/**
 * Drawback Chess board authority.
 *
 * It deliberately uses geometric (pseudo-legal) chess moves: checks may be
 * ignored, pinned pieces may move, and kings may enter attacked squares.
 * Capturing the opposing king is an immediate terminal move. Castling ignores
 * attacked squares and records the site's one-reply king-en-passant right.
 */
export class CapturableKingPosition {
  readonly #position: Chess;
  #kingPassant: KingPassantRight | null;
  #orthodoxCompatible: boolean;
  #terminal: CapturableKingTerminal;

  private constructor(
    position: Chess,
    kingPassant: KingPassantRight | null,
    orthodoxCompatible: boolean,
    terminal: CapturableKingTerminal,
  ) {
    this.#position = position;
    this.#kingPassant =
      kingPassant === null ? null : structuredClone(kingPassant);
    this.#orthodoxCompatible = orthodoxCompatible;
    this.#terminal = terminal === null ? null : structuredClone(terminal);
  }

  public static fromFen(fen?: string): CapturableKingPosition {
    const setup = parseFen(fen ?? INITIAL_FEN).unwrap();
    const position = positionFromSetup(setup);
    assertExactlyOneKingPerColor(position);
    return new CapturableKingPosition(
      position,
      null,
      isOrthodoxFen(position),
      null,
    );
  }

  /**
   * Restore the complete public board authority state.
   *
   * The snapshot contains no drawback rule, parameters, state, or replay RNG.
   * Unlike FEN alone it preserves the variant's one-reply king-passant right,
   * terminal latch, and the full-line orthodox-compatibility decision.
   */
  public static fromSnapshot(snapshot: unknown): CapturableKingPosition {
    const value = validateSnapshot(snapshot);
    const setup = parseFen(value.fen).unwrap();
    const position = positionFromSetup(setup);
    validateSnapshotPosition(position, value);
    return new CapturableKingPosition(
      position,
      value.kingPassant === null
        ? null
        : {
            victim: value.kingPassant.victim,
            kingSquare: requiredSquare(value.kingPassant.kingSquare),
            targets: value.kingPassant.targets.map(requiredSquare),
          },
      value.orthodoxCompatible,
      value.terminal,
    );
  }

  public get fen(): string {
    return makeFen(this.#position.toSetup());
  }

  public get turn(): PlayerColor {
    return this.#position.turn;
  }

  /**
   * True only while the complete line is still legal orthodox chess.
   * Stockfish leaf evaluation must fail closed when this is false.
   */
  public get orthodoxCompatible(): boolean {
    return this.#orthodoxCompatible;
  }

  public clone(): CapturableKingPosition {
    return new CapturableKingPosition(
      this.#position.clone(),
      this.#kingPassant,
      this.#orthodoxCompatible,
      this.#terminal,
    );
  }

  /**
   * Export an immutable, board-only capability snapshot suitable for
   * player-private search forks.
   */
  public snapshot(): CapturableKingPositionSnapshot {
    return deepFreeze({
      format: "drawbackengine-public-position",
      version: 1,
      authorityId: "capturable-king/v1",
      fen: this.fen,
      orthodoxCompatible: this.#orthodoxCompatible,
      kingPassant:
        this.#kingPassant === null
          ? null
          : {
              victim: this.#kingPassant.victim,
              kingSquare: makeSquare(this.#kingPassant.kingSquare),
              targets: this.#kingPassant.targets.map(makeSquare),
            },
      terminal:
        this.#terminal === null ? null : structuredClone(this.#terminal),
    });
  }

  public legalMoves(): readonly ChessMove[] {
    if (this.#terminal !== null) {
      return [];
    }
    return this.#generateMoves().map(({ move }) => move);
  }

  public move(command: MoveCommand): CapturableKingMoveResult | null {
    if (this.#terminal !== null) {
      return null;
    }
    const generated = this.#generateMoves().find(({ move }) =>
      sameMove(command, move),
    );
    if (generated === undefined) {
      return null;
    }

    const movingColor = this.turn;
    const wasOrthodox = this.#orthodoxCompatible;
    const orthodoxMove = wasOrthodox && isOrthodoxMove(this.fen, generated.move);
    const previousKingPassant = this.#kingPassant;
    this.#kingPassant = null;
    this.#position.play(generated.operation);

    let terminal: CapturableKingTerminal = null;
    if (generated.kingPassant !== undefined) {
      this.#position.board.take(generated.kingPassant.kingSquare);
      terminal = {
        kind: "king-capture",
        winner: movingColor,
        capturedKing: generated.kingPassant.victim,
        move: generated.move,
        method: "castling-en-passant",
      };
    } else if (generated.move.captured === "king") {
      terminal = {
        kind: "king-capture",
        winner: movingColor,
        capturedKing: oppositeColor(movingColor),
        move: generated.move,
        method: "direct",
      };
    } else if (generated.castleSide !== undefined) {
      this.#kingPassant = this.#castlingEnPassantRight(
        movingColor,
        generated.castleSide,
      );
    }

    this.#terminal = terminal;
    this.#orthodoxCompatible =
      terminal === null && previousKingPassant === null && orthodoxMove;
    return { move: generated.move, terminal };
  }

  #generateMoves(): readonly GeneratedMove[] {
    const generated = new Map<string, GeneratedMove>();
    const context: Context = {
      king: this.#position.board.kingOf(this.#position.turn),
      blockers: SquareSet.empty(),
      checkers: SquareSet.empty(),
      variantEnd: false,
      mustCapture: false,
    };

    for (const from of this.#position.board[this.#position.turn]) {
      const piece = this.#position.board.get(from);
      if (piece === undefined) {
        continue;
      }
      for (const rawTo of pseudoDests(this.#position, from, context)) {
        const castleSide = this.#castleSide(from, rawTo, piece);
        const to =
          castleSide === undefined
            ? rawTo
            : kingCastlesTo(this.#position.turn, castleSide);
        this.#appendMoves(generated, from, to, piece, castleSide);
      }
    }

    for (const side of ["a", "h"] as const) {
      const castle = this.#unrestrictedCastle(side);
      if (castle !== null) {
        this.#appendMoves(
          generated,
          castle.from,
          castle.to,
          castle.piece,
          side,
        );
      }
    }

    if (
      this.#kingPassant !== null
      && this.#kingPassant.victim !== this.turn
    ) {
      for (const from of this.#position.board[this.#position.turn]) {
        const piece = this.#position.board.get(from);
        if (piece === undefined) {
          continue;
        }
        for (const target of this.#kingPassant.targets) {
          if (!this.#canReachKingPassantTarget(from, target, piece, context)) {
            continue;
          }
          this.#appendMoves(
            generated,
            from,
            target,
            piece,
            undefined,
            this.#kingPassant,
          );
        }
      }
    }

    return [...generated.values()].sort((left, right) =>
      moveId(left.move).localeCompare(moveId(right.move)),
    );
  }

  #appendMoves(
    generated: Map<string, GeneratedMove>,
    from: Square,
    to: Square,
    piece: Piece,
    castleSide?: CastlingSide,
    kingPassant?: KingPassantRight,
  ): void {
    const promotion =
      piece.role === "pawn" && (to < 8 || to >= 56) ? PROMOTIONS : [undefined];
    for (const promoted of promotion) {
      const operation: NormalMove = {
        from,
        to,
        ...(promoted === undefined ? {} : { promotion: promoted }),
      };
      const move = this.#toPublicMove(
        operation,
        piece,
        castleSide,
        kingPassant,
      );
      generated.set(moveId(move), {
        move,
        operation,
        ...(castleSide === undefined ? {} : { castleSide }),
        ...(kingPassant === undefined ? {} : { kingPassant }),
      });
    }
  }

  #toPublicMove(
    operation: NormalMove,
    piece: Piece,
    castleSide?: CastlingSide,
    kingPassant?: KingPassantRight,
  ): ChessMove {
    const target = this.#position.board.get(operation.to);
    const enPassant =
      piece.role === "pawn"
      && this.#position.epSquare === operation.to
      && target === undefined;
    const captured =
      kingPassant !== undefined
        ? "king"
        : target !== undefined && target.color !== piece.color
          ? target.role
          : enPassant
            ? "pawn"
            : undefined;
    const from = makeSquare(operation.from);
    const to = makeSquare(operation.to);
    const capture = captured !== undefined;
    const promotion = operation.promotion as PromotionPiece | undefined;
    const baseSan =
      castleSide === "h"
        ? "O-O"
        : castleSide === "a"
          ? "O-O-O"
          : `${PIECE_LETTER[piece.role]}${
              piece.role === "pawn" && capture ? from.charAt(0) : ""
            }${capture ? "x" : ""}${to}${
              promotion === undefined ? "" : `=${PIECE_LETTER[promotion]}`
            }`;
    const givesCheck =
      captured !== "king"
      && this.#wouldAttackKing(operation, piece.color);
    return {
      from,
      to,
      color: piece.color,
      piece: piece.role,
      ...(captured === undefined ? {} : { captured }),
      ...(promotion === undefined ? {} : { promotion }),
      san: `${baseSan}${givesCheck ? "+" : ""}`,
      flags: [
        capture ? "capture" : "quiet",
        promotion === undefined ? "" : "promotion",
        enPassant ? "en-passant" : "",
        kingPassant === undefined ? "" : "king-en-passant",
        castleSide === "h" ? "kingside-castle" : "",
        castleSide === "a" ? "queenside-castle" : "",
      ]
        .filter((flag) => flag.length > 0)
        .join(","),
    };
  }

  #wouldAttackKing(operation: NormalMove, movingColor: Color): boolean {
    const preview = this.#position.clone();
    preview.play(operation);
    const enemyKing = preview.board.kingOf(oppositeColor(movingColor));
    return (
      enemyKing !== undefined
      && preview
        .kingAttackers(enemyKing, movingColor, preview.board.occupied)
        .nonEmpty()
    );
  }

  #castleSide(
    from: Square,
    to: Square,
    piece: Piece,
  ): CastlingSide | undefined {
    if (piece.role !== "king") {
      return undefined;
    }
    for (const side of ["a", "h"] as const) {
      if (this.#position.castles.rook[this.turn][side] === to) {
        return side;
      }
    }
    const delta = to - from;
    return Math.abs(delta) === 2 ? (delta > 0 ? "h" : "a") : undefined;
  }

  #unrestrictedCastle(
    side: CastlingSide,
  ): { readonly from: Square; readonly to: Square; readonly piece: Piece } | null {
    const from = this.#position.board.kingOf(this.turn);
    const rook = this.#position.castles.rook[this.turn][side];
    if (
      from === undefined
      || rook === undefined
      || this.#position.castles.path[this.turn][side].intersects(
        this.#position.board.occupied,
      )
    ) {
      return null;
    }
    const piece = this.#position.board.get(from);
    if (piece?.role !== "king" || piece.color !== this.turn) {
      return null;
    }
    return {
      from,
      to: kingCastlesTo(this.turn, side),
      piece,
    };
  }

  #castlingEnPassantRight(
    victim: PlayerColor,
    side: CastlingSide,
  ): KingPassantRight | null {
    return deriveKingPassantRight(this.#position, victim, side);
  }

  #canReachKingPassantTarget(
    from: Square,
    target: Square,
    piece: Piece,
    context: Context,
  ): boolean {
    if (pseudoDests(this.#position, from, context).has(target)) {
      return true;
    }
    return (
      piece.role === "pawn"
      && this.#position.board.get(target) === undefined
      && pawnAttacks(piece.color, from).has(target)
    );
  }
}

function moveId(move: Pick<ChessMove, "from" | "to" | "promotion">): string {
  return `${move.from}${move.to}${move.promotion?.[0] ?? ""}`;
}

function oppositeColor(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function deriveKingPassantRight(
  postCastle: Chess,
  victim: PlayerColor,
  side: CastlingSide,
): KingPassantRight | null {
  const home = victim === "white" ? parseSquare("e1") : parseSquare("e8");
  const through = rookCastlesTo(victim, side);
  const opponent = oppositeColor(victim);
  const attacked: Square[] = [];
  const beforeCastle = postCastle.clone();
  // The castle is already applied. Restore the home occupancy to verify the
  // exact attacked squares that grant the site's one-reply capture.
  const kingTo = kingCastlesTo(victim, side);
  const rookTo = rookCastlesTo(victim, side);
  const rookFrom = side === "h"
    ? victim === "white" ? parseSquare("h1") : parseSquare("h8")
    : victim === "white" ? parseSquare("a1") : parseSquare("a8");
  const king = beforeCastle.board.take(kingTo);
  const rook = beforeCastle.board.take(rookTo);
  if (
    king?.role !== "king"
    || king.color !== victim
    || rook?.role !== "rook"
    || rook.color !== victim
  ) {
    return null;
  }
  beforeCastle.board.set(home, king);
  beforeCastle.board.set(rookFrom, rook);

  if (
    beforeCastle
      .kingAttackers(home, opponent, beforeCastle.board.occupied)
      .nonEmpty()
  ) {
    attacked.push(home);
  }
  const throughOccupancy = beforeCastle.board.occupied
    .without(home)
    .with(through);
  if (
    beforeCastle
      .kingAttackers(through, opponent, throughOccupancy)
      .nonEmpty()
  ) {
    attacked.push(through);
  }
  return attacked.length === 0
    ? null
    : {
        victim,
        kingSquare: kingTo,
        targets: attacked,
      };
}

function isOrthodoxFen(position: Chess): boolean {
  try {
    Chess.fromSetup(position.toSetup()).unwrap();
    new OrthodoxChess(makeFen(position.toSetup()));
    return true;
  } catch {
    return false;
  }
}

function positionFromSetup(setup: Setup): Chess {
  // Chess.fromSetup intentionally rejects a position where the side to move is
  // already attacking the opposing king. That is a normal, non-terminal
  // Drawback Chess position when the opponent declined a king capture.
  const position = Chess.default();
  position.board = setup.board.clone();
  position.pockets = undefined;
  position.turn = setup.turn;
  position.castles = Castles.fromSetup(setup);
  position.epSquare = setup.epSquare;
  position.remainingChecks = undefined;
  position.halfmoves = setup.halfmoves;
  position.fullmoves = setup.fullmoves;
  return position;
}

function assertExactlyOneKingPerColor(position: Chess): void {
  const whiteKings = position.board.pieces("white", "king").size();
  const blackKings = position.board.pieces("black", "king").size();
  if (whiteKings !== 1 || blackKings !== 1) {
    throw new RangeError(
      "capturable-king/v1 requires exactly one white king and one black king.",
    );
  }
}

function isOrthodoxMove(fen: string, candidate: ChessMove): boolean {
  try {
    const chess = new OrthodoxChess(fen);
    return chess
      .moves({ verbose: true })
      .some((move) =>
        sameMove(candidate, {
          from: move.from,
          to: move.to,
          ...(move.promotion === undefined
            ? {}
            : {
                promotion:
                  move.promotion === "n"
                    ? "knight"
                    : move.promotion === "b"
                      ? "bishop"
                      : move.promotion === "r"
                        ? "rook"
                        : "queen",
              }),
        }),
      );
  } catch {
    return false;
  }
}

function validateSnapshot(snapshot: unknown): CapturableKingPositionSnapshot {
  const value = requiredRecord(snapshot, "position snapshot");
  exactKeys(
    value,
    [
      "format",
      "version",
      "authorityId",
      "fen",
      "orthodoxCompatible",
      "kingPassant",
      "terminal",
    ],
    "position snapshot",
  );
  if (
    value["format"] !== "drawbackengine-public-position"
    || value["version"] !== 1
    || value["authorityId"] !== "capturable-king/v1"
    || typeof value["fen"] !== "string"
    || typeof value["orthodoxCompatible"] !== "boolean"
  ) {
    throw new TypeError("Position snapshot header is invalid.");
  }
  const kingPassant = validateKingPassant(value["kingPassant"]);
  const terminal = validateTerminal(value["terminal"]);
  if (kingPassant !== null && terminal !== null) {
    throw new TypeError(
      "A terminal position snapshot cannot retain a king-passant right.",
    );
  }
  if (terminal !== null && value["orthodoxCompatible"]) {
    throw new TypeError(
      "A terminal king-capture snapshot cannot be orthodox compatible.",
    );
  }
  return {
    format: "drawbackengine-public-position",
    version: 1,
    authorityId: "capturable-king/v1",
    fen: value["fen"],
    orthodoxCompatible: value["orthodoxCompatible"],
    kingPassant,
    terminal,
  };
}

function validateKingPassant(
  input: unknown,
): CapturableKingPositionSnapshot["kingPassant"] {
  if (input === null) {
    return null;
  }
  const value = requiredRecord(input, "kingPassant");
  exactKeys(value, ["victim", "kingSquare", "targets"], "kingPassant");
  const victim = requiredColor(value["victim"], "kingPassant.victim");
  if (typeof value["kingSquare"] !== "string") {
    throw new TypeError("kingPassant.kingSquare must be a square.");
  }
  requiredSquare(value["kingSquare"]);
  if (!Array.isArray(value["targets"]) || value["targets"].length === 0) {
    throw new TypeError("kingPassant.targets must be a non-empty square array.");
  }
  const targets = value["targets"].map((target) => {
    if (typeof target !== "string") {
      throw new TypeError("kingPassant.targets must contain squares.");
    }
    requiredSquare(target);
    return target;
  });
  if (new Set(targets).size !== targets.length) {
    throw new TypeError("kingPassant.targets cannot contain duplicates.");
  }
  const expected = expectedKingPassantGeometry(victim, value["kingSquare"]);
  if (expected === null || targets.some((target) => !expected.has(target))) {
    throw new TypeError("kingPassant geometry is invalid.");
  }
  return {
    victim,
    kingSquare: value["kingSquare"],
    targets,
  };
}

function validateTerminal(input: unknown): CapturableKingTerminal {
  if (input === null) {
    return null;
  }
  const value = requiredRecord(input, "terminal");
  exactKeys(
    value,
    ["kind", "winner", "capturedKing", "move", "method"],
    "terminal",
  );
  if (value["kind"] !== "king-capture") {
    throw new TypeError("terminal.kind is invalid.");
  }
  const winner = requiredColor(value["winner"], "terminal.winner");
  const capturedKing = requiredColor(
    value["capturedKing"],
    "terminal.capturedKing",
  );
  if (winner === capturedKing) {
    throw new TypeError("Terminal winner cannot be the captured king.");
  }
  if (
    value["method"] !== "direct"
    && value["method"] !== "castling-en-passant"
  ) {
    throw new TypeError("terminal.method is invalid.");
  }
  const move = validateChessMove(value["move"]);
  if (
    move.color !== winner
    || move.captured !== "king"
    || (value["method"] === "castling-en-passant"
      && !move.flags.split(",").includes("king-en-passant"))
  ) {
    throw new TypeError("Terminal move is inconsistent with the king capture.");
  }
  return {
    kind: "king-capture",
    winner,
    capturedKing,
    move,
    method: value["method"],
  };
}

function validateChessMove(input: unknown): ChessMove {
  const value = requiredRecord(input, "terminal.move");
  const optional = ["captured", "promotion"];
  const required = ["from", "to", "color", "piece", "san", "flags"];
  exactKeys(value, [...required, ...optional], "terminal.move", true);
  for (const key of required) {
    if (!(key in value)) {
      throw new TypeError(`terminal.move.${key} is required.`);
    }
  }
  if (
    typeof value["from"] !== "string"
    || typeof value["to"] !== "string"
    || typeof value["san"] !== "string"
    || typeof value["flags"] !== "string"
  ) {
    throw new TypeError("Terminal move text fields are invalid.");
  }
  requiredSquare(value["from"]);
  requiredSquare(value["to"]);
  const color = requiredColor(value["color"], "terminal.move.color");
  const pieces = ["pawn", "knight", "bishop", "rook", "queen", "king"] as const;
  if (!pieces.includes(value["piece"] as (typeof pieces)[number])) {
    throw new TypeError("terminal.move.piece is invalid.");
  }
  if (value["captured"] !== "king") {
    throw new TypeError("terminal.move.captured must be king.");
  }
  const promotions = ["knight", "bishop", "rook", "queen"] as const;
  if (
    value["promotion"] !== undefined
    && !promotions.includes(
      value["promotion"] as (typeof promotions)[number],
    )
  ) {
    throw new TypeError("terminal.move.promotion is invalid.");
  }
  return {
    from: value["from"],
    to: value["to"],
    color,
    piece: value["piece"] as ChessMove["piece"],
    captured: "king",
    ...(value["promotion"] === undefined
      ? {}
      : { promotion: value["promotion"] as PromotionPiece }),
    san: value["san"],
    flags: value["flags"],
  };
}

function validateSnapshotPosition(
  position: Chess,
  snapshot: CapturableKingPositionSnapshot,
): void {
  const whiteKings = position.board.pieces("white", "king").size();
  const blackKings = position.board.pieces("black", "king").size();
  if (snapshot.terminal === null) {
    assertExactlyOneKingPerColor(position);
  } else {
    const winnerKings = snapshot.terminal.winner === "white"
      ? whiteKings
      : blackKings;
    const capturedKings = snapshot.terminal.capturedKing === "white"
      ? whiteKings
      : blackKings;
    if (winnerKings !== 1 || capturedKings !== 0) {
      throw new RangeError(
        "Terminal snapshot board does not match its captured king.",
      );
    }
    if (position.turn !== snapshot.terminal.capturedKing) {
      throw new RangeError("Terminal snapshot turn does not match captured king.");
    }
  }
  if (snapshot.kingPassant !== null) {
    if (position.turn === snapshot.kingPassant.victim) {
      throw new RangeError("kingPassant must belong to the previous mover.");
    }
    const king = position.board.get(
      requiredSquare(snapshot.kingPassant.kingSquare),
    );
    if (
      king?.role !== "king"
      || king.color !== snapshot.kingPassant.victim
    ) {
      throw new RangeError("kingPassant kingSquare does not contain its king.");
    }
    const side: CastlingSide =
      snapshot.kingPassant.kingSquare.charAt(0) === "g" ? "h" : "a";
    const derived = deriveKingPassantRight(
      position,
      snapshot.kingPassant.victim,
      side,
    );
    const suppliedTargets = [...snapshot.kingPassant.targets].sort();
    const derivedTargets =
      derived === null ? [] : derived.targets.map(makeSquare).sort();
    if (
      derived === null
      || makeSquare(derived.kingSquare) !== snapshot.kingPassant.kingSquare
      || suppliedTargets.length !== derivedTargets.length
      || suppliedTargets.some(
        (target, index) => target !== derivedTargets[index],
      )
    ) {
      throw new RangeError(
        "kingPassant right does not match an attacked castling path.",
      );
    }
  }
  if (snapshot.orthodoxCompatible && !isOrthodoxFen(position)) {
    throw new RangeError(
      "Snapshot cannot claim orthodox compatibility for this board.",
    );
  }
}

function expectedKingPassantGeometry(
  victim: PlayerColor,
  kingSquare: string,
): ReadonlySet<string> | null {
  const rank = victim === "white" ? "1" : "8";
  if (kingSquare === `g${rank}`) {
    return new Set([`e${rank}`, `f${rank}`]);
  }
  if (kingSquare === `c${rank}`) {
    return new Set([`e${rank}`, `d${rank}`]);
  }
  return null;
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
  allowMissing = false,
): void {
  const actual = Object.keys(value);
  if (
    actual.some((key) => !allowed.includes(key))
    || (!allowMissing && allowed.some((key) => !actual.includes(key)))
  ) {
    throw new TypeError(`${label} has invalid fields.`);
  }
}

function requiredColor(value: unknown, label: string): PlayerColor {
  if (value !== "white" && value !== "black") {
    throw new TypeError(`${label} must be white or black.`);
  }
  return value;
}

function requiredSquare(value: string): Square {
  const square = parseSquare(value);
  if (square === undefined) {
    throw new TypeError(`${value} is not a valid square.`);
  }
  return square;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
