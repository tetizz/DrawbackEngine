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
