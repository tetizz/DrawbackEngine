import { Worker } from "node:worker_threads";
import type {
  PlayerPrivateWorkerInitialization,
} from "./player-private-worker-protocol.js";

export interface PlayerPrivateWorkerTransportHandlers {
  readonly message: (value: unknown) => void;
  readonly error: (error: Error) => void;
  readonly exit: (code: number) => void;
}

export interface PlayerPrivateWorkerTransport {
  postMessage(value: unknown): void;
  subscribe(handlers: PlayerPrivateWorkerTransportHandlers): () => void;
  terminate(): Promise<number>;
}

export interface PlayerPrivateWorkerFactoryRequest {
  readonly entry: URL;
  readonly workerData: PlayerPrivateWorkerInitialization;
  readonly execArgv: readonly string[];
}

export type PlayerPrivateWorkerFactory = (
  request: PlayerPrivateWorkerFactoryRequest,
) => PlayerPrivateWorkerTransport;

export const createNodePlayerPrivateWorker: PlayerPrivateWorkerFactory = (
  request,
) => {
  const worker = new Worker(request.entry, {
    workerData: request.workerData,
    execArgv: [...request.execArgv],
    stdout: true,
    stderr: true,
  });
  return {
    postMessage(value: unknown): void {
      worker.postMessage(value);
    },
    subscribe(handlers: PlayerPrivateWorkerTransportHandlers): () => void {
      let outputFailureReported = false;
      const reportUnexpectedOutput = (stream: "stdout" | "stderr"): void => {
        if (outputFailureReported) {
          return;
        }
        outputFailureReported = true;
        handlers.error(
          new Error(`Player-private worker wrote unexpected ${stream} output.`),
        );
      };
      const onStdout = (): void => {
        reportUnexpectedOutput("stdout");
      };
      const onStderr = (): void => {
        reportUnexpectedOutput("stderr");
      };
      worker.on("message", handlers.message);
      worker.on("error", handlers.error);
      worker.on("exit", handlers.exit);
      worker.stdout.on("data", onStdout);
      worker.stderr.on("data", onStderr);
      return (): void => {
        worker.off("message", handlers.message);
        worker.off("error", handlers.error);
        worker.off("exit", handlers.exit);
        worker.stdout.off("data", onStdout);
        worker.stderr.off("data", onStderr);
      };
    },
    terminate(): Promise<number> {
      return worker.terminate();
    },
  };
};
