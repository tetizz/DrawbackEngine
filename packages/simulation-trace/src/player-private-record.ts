import {
  parsePlayerPrivateSimulationTraceRecord,
} from "./player-private-validation.js";

export function encodePlayerPrivateSimulationTraceRecord(
  record: unknown,
): string {
  return `${JSON.stringify(
    parsePlayerPrivateSimulationTraceRecord(record),
  )}\n`;
}
