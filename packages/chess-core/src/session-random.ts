import type { RandomSource } from "@drawbackengine/shared";

export interface SessionParameterRandomSources {
  readonly white: RandomSource;
  readonly black: RandomSource;
}

export type SessionParameterRandomInput =
  | RandomSource
  | SessionParameterRandomSources;

export function resolveSessionParameterRandomSources(
  input: SessionParameterRandomInput,
): SessionParameterRandomSources {
  if ("white" in input && "black" in input) {
    return input;
  }
  return {
    white: input,
    black: input,
  };
}
