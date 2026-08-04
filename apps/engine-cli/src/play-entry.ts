import { runPlayerPrivatePlayCli } from "./play-cli.js";
import { formatPublicFailureMessage } from "./failure-redaction.js";
import { retryRetainedCleanup } from "./retained-cleanup.js";
import {
  findCleanupTerminationError,
  installTerminationSignal,
} from "./termination-signal.js";

const termination = installTerminationSignal();

void runPlayerPrivatePlayCli({ signal: termination.signal })
  .catch(async (error: unknown) => {
    const reported = await retryRetainedCleanup(error, 2);
    const message = formatPublicFailureMessage(
      reported,
      "Unknown local play error.",
    );
    process.stderr.write(`Local play failed: ${message}\n`);
    process.exitCode = findCleanupTerminationError(reported)?.exitCode ?? 1;
  })
  .finally(() => {
    termination.dispose();
  });
