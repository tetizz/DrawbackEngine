import type {
  DrawbackPlayReveal,
  PlayerPlayObservationV1,
  PlayerPrivatePlayReveal,
  PlayerVisibleMove,
} from "@drawbackengine/simulation-arena";
import type { PlayerColor } from "@drawbackengine/shared";

export const PLAY_WEB_API_VERSION = "drawbackengine-play-web/v1" as const;

export const PLAY_STRENGTHS = Object.freeze([
  Object.freeze({
    id: "quick",
    label: "Quick",
    summary: "A small outer-tree budget for fast replies.",
    maxDepth: 1,
    maxNodes: 5_000,
  }),
  Object.freeze({
    id: "balanced",
    label: "Balanced",
    summary: "A broader two-ply drawback search.",
    maxDepth: 2,
    maxNodes: 50_000,
  }),
  Object.freeze({
    id: "deep",
    label: "Deep",
    summary: "The largest local preset for a tougher, slower game.",
    maxDepth: 3,
    maxNodes: 250_000,
  }),
] as const);

export type PlayStrengthId = (typeof PLAY_STRENGTHS)[number]["id"];
export type PlayStrength = (typeof PLAY_STRENGTHS)[number];

export interface PlayDrawbackChoice {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly verification: DrawbackPlayReveal["verification"];
}

export interface PlayEvaluatorMetadata {
  readonly kind: "Fairy-Stockfish";
  readonly name: string;
  readonly version: string;
  readonly leafDepth: number;
  readonly hashMb: number;
  readonly threads: 1;
  readonly multiPv: 1;
  readonly limitStrength: false;
  readonly skillLevel: 20;
  readonly nnue: "configured" | "disabled";
}

export interface PlayBootstrapResponse {
  readonly schema: typeof PLAY_WEB_API_VERSION;
  readonly evaluator: PlayEvaluatorMetadata;
  readonly strengths: readonly PlayStrength[];
  readonly drawbacks: readonly PlayDrawbackChoice[];
}

export interface CreatePlayGameRequest {
  readonly humanColor: PlayerColor;
  readonly humanDrawbackId: string;
  readonly strengthId: PlayStrengthId;
}

export interface SubmitPlayActionRequest {
  readonly actionId: string;
  readonly expectedPly: number;
}

export interface PlayMoveRecord extends PlayerVisibleMove {
  readonly ply: number;
  readonly color: PlayerColor;
}

export interface PlayGameSnapshot {
  readonly schema: typeof PLAY_WEB_API_VERSION;
  readonly gameId: string;
  readonly observation: PlayerPlayObservationV1;
  readonly moves: readonly PlayMoveRecord[];
  readonly strength: PlayStrength;
  readonly evaluator: PlayEvaluatorMetadata;
  readonly thinking: boolean;
  readonly reveal: PlayerPrivatePlayReveal | null;
}

export interface PlayApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export function resolvePlayStrength(id: string): PlayStrength | undefined {
  return PLAY_STRENGTHS.find((strength) => strength.id === id);
}
