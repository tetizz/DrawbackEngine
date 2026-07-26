import type {
  ChessMove,
  PositionAuthorityId,
} from "@drawbackengine/drawback-engine";
import type { PlayerColor } from "@drawbackengine/shared";

export interface LeafPosition {
  readonly authorityId: PositionAuthorityId;
  readonly fen: string;
  readonly turn: PlayerColor;
  readonly legalMoves: readonly ChessMove[];
  readonly history: readonly ChessMove[];
  readonly orthodoxCompatible: boolean;
  /**
   * Exact public variant state that FEN cannot encode. Variant evaluators must
   * fail closed when they cannot represent an active right.
   */
  readonly kingPassantActive: boolean;
}

/**
 * Centipawn score from the supplied side-to-move's perspective.
 */
export interface DrawbackLeafEvaluator {
  readonly id: string;
  evaluate(position: LeafPosition, signal?: AbortSignal): Promise<number>;
}

/**
 * Typed fail-closed signal for a public position that an evaluator cannot
 * represent exactly. Diagnostic callers may report this as missing coverage;
 * operational evaluator failures remain errors.
 */
export class UnsupportedDrawbackLeafPositionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedDrawbackLeafPositionError";
  }
}

export interface DrawbackSearchLimits {
  readonly depth: number;
  readonly maxNodes: number;
  readonly signal?: AbortSignal;
}

export interface DrawbackSearchResult {
  readonly move: ChessMove;
  /** Centipawns from the root player's perspective. */
  readonly score: number;
  readonly principalVariation: readonly ChessMove[];
  readonly nodes: number;
  readonly leaves: number;
  readonly truncated: boolean;
  readonly rootColor: PlayerColor;
  readonly evaluatorId: string;
  readonly knowledgeMode: "omniscient-oracle";
}

export interface DrawbackRootMoveSearchResult {
  readonly move: ChessMove;
  /** Centipawns from the root player's perspective. */
  readonly score: number;
  readonly principalVariation: readonly ChessMove[];
  readonly nodes: number;
  readonly leaves: number;
  readonly truncated: boolean;
  readonly rootColor: PlayerColor;
  readonly evaluatorId: string;
  readonly knowledgeMode: "omniscient-oracle";
  readonly depth: number;
}
