import {
  IncompleteSameOwnerCleanupError,
} from "@drawbackengine/chess-evaluator";
import {
  PlayerPrivateWorkerPoolCleanupError,
} from "@drawbackengine/simulation-arena";
import { RetainedFileCleanupError } from "./atomic-ndjson.js";
import { RetainedCleanupReportError } from "./retained-cleanup.js";

const QUOTED_DOUBLE_ABSOLUTE_PATH =
  /"(?:[A-Za-z]:[\\/]|\\\\|\/)[^"\r\n]+"/gu;
const QUOTED_SINGLE_ABSOLUTE_PATH =
  /'(?:[A-Za-z]:[\\/]|\\\\|\/)[^'\r\n]+'/gu;
const WINDOWS_DRIVE_PATH =
  /\b[A-Za-z]:[\\/][^\s"'<>|?*\r\n]*/gu;
const WINDOWS_UNC_PATH =
  /\\\\[^\\/\s"'<>|?*\r\n]+[\\/][^\s"'<>|?*\r\n]+/gu;
const UNQUOTED_POSIX_PATH =
  /(^|[\s"'`(=[{,:])\/[^\s/"'`<>{}[\](),;:]+(?:\/[^\s/"'`<>{}[\](),;:]+)*/gu;

/** Removes absolute local filesystem locations before CLI failures are public. */
export function redactLocalPaths(message: string): string {
  return message
    .replace(QUOTED_DOUBLE_ABSOLUTE_PATH, "<local-path>")
    .replace(QUOTED_SINGLE_ABSOLUTE_PATH, "<local-path>")
    .replace(WINDOWS_UNC_PATH, "<local-path>")
    .replace(WINDOWS_DRIVE_PATH, "<local-path>")
    .replace(UNQUOTED_POSIX_PATH, "$1<local-path>");
}

/** Preserves an actionable retained-cleanup cause without exposing local paths. */
export function formatPublicFailureMessage(
  value: unknown,
  fallback: string,
): string {
  const cause = firstRetainedCleanupCause(value);
  const causeMessage = cause instanceof Error ? cause.message : fallback;
  const cleanupStatus = isRetainedCleanupWrapper(value)
    ? value.message
    : undefined;
  const message = cleanupStatus === undefined || cleanupStatus === causeMessage
    ? causeMessage
    : `${causeMessage} ${cleanupStatus}`;
  return redactLocalPaths(message);
}

function firstRetainedCleanupCause(value: unknown): unknown {
  const pending: unknown[] = [value];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (!isRetainedCleanupWrapper(current)) {
      return current;
    }
    const errors = current.errors as readonly unknown[];
    for (let index = errors.length - 1; index >= 0; index -= 1) {
      pending.push(errors[index]);
    }
  }
  return undefined;
}

function isRetainedCleanupWrapper(value: unknown): value is AggregateError {
  return value instanceof RetainedCleanupReportError
    || value instanceof PlayerPrivateWorkerPoolCleanupError
    || value instanceof IncompleteSameOwnerCleanupError
    || value instanceof RetainedFileCleanupError;
}
