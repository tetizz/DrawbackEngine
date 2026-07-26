import { parsePrivateSimulationTraceRecord } from "./validation.js";

export function encodePrivateSimulationTraceRecord(
  record: unknown,
): string {
  return `${JSON.stringify(parsePrivateSimulationTraceRecord(record))}\n`;
}
