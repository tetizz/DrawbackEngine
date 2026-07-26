import type { PlayerColor, RandomSource } from "@drawbackengine/shared";

export type RuleVerification =
  | "verified"
  | "implemented-unverified"
  | "partial"
  | "unsupported";

export type PositionAuthorityId =
  | "standard-chess/v1"
  | "capturable-king/v1";

export type PieceType = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";
export type PromotionPiece = "knight" | "bishop" | "rook" | "queen";

export interface ChessMove {
  readonly from: string;
  readonly to: string;
  readonly color: PlayerColor;
  readonly piece: PieceType;
  readonly captured?: PieceType;
  readonly promotion?: PromotionPiece;
  readonly san: string;
  readonly flags: string;
}

export interface PositionView {
  readonly fen: string;
  readonly turn: PlayerColor;
  readonly ply: number;
  readonly history: readonly ChessMove[];
}

export interface RuleEvidence {
  readonly ruleId: string;
  readonly kind: "allowed" | "eliminated" | "triggered" | "forced" | "likelihood";
  readonly message: string;
  readonly move?: ChessMove;
  readonly weight?: number;
}

export interface DrawbackLoss {
  readonly ruleId: string;
  readonly color: PlayerColor;
  readonly reason: string;
}

export interface RuleInitializationContext<Parameters> {
  readonly color: PlayerColor;
  readonly parameters: Readonly<Parameters>;
  readonly position: PositionView;
}

export interface RuleMoveContext<State, Parameters>
  extends RuleInitializationContext<Parameters> {
  readonly state: Readonly<State>;
}

export interface RuleTransitionContext<State, Parameters>
  extends RuleMoveContext<State, Parameters> {
  readonly positionAfterMove: PositionView;
}

export type RuleLossContext<State, Parameters> = RuleMoveContext<State, Parameters>;

export interface DrawbackRule<State, Parameters> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly verification: RuleVerification;
  /**
   * Authorities against which this rule's executable implementation has been
   * audited. Omission means orthodox compatibility only.
   */
  readonly supportedAuthorities?: readonly PositionAuthorityId[];

  generateParameters(rng: RandomSource): Parameters;
  /**
   * Strict runtime parser for parameters received outside trusted TypeScript
   * call sites. Rules with a closed parameter schema should reject unknown
   * object shapes and return a normalized value.
   */
  validateParameters?(parameters: unknown): Parameters;
  initialize(context: RuleInitializationContext<Parameters>): State;
  filterLegalMoves(
    context: RuleMoveContext<State, Parameters>,
    moves: readonly ChessMove[],
  ): readonly ChessMove[];
  applyMove(
    context: RuleTransitionContext<State, Parameters>,
    move: ChessMove,
  ): State;
  checkStartOfTurnLoss(
    context: RuleLossContext<State, Parameters>,
  ): DrawbackLoss | null;
  explainMove?(
    context: RuleMoveContext<State, Parameters>,
    move: ChessMove,
  ): readonly RuleEvidence[];
  /**
   * Private turn information shown only to the affected player.
   * Implementations must not include engine replay seeds.
   */
  describeTurn?(
    context: RuleMoveContext<State, Parameters>,
  ): readonly string[];
}

export interface RuleRuntime<State, Parameters> {
  readonly rule: DrawbackRule<State, Parameters>;
  readonly parameters: Readonly<Parameters>;
  readonly state: Readonly<State>;
}

export type UnknownRule = DrawbackRule<unknown, unknown>;
