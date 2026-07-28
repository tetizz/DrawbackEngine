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
  });
  return {
    postMessage(value: unknown): void {
      worker.postMessage(value);
    },
    subscribe(handlers: PlayerPrivateWorkerTransportHandlers): () => void {
      worker.on("message", handlers.message);
      worker.on("error", handlers.error);
      worker.on("exit", handlers.exit);
      return (): void => {
        worker.off("message", handlers.message);
        worker.off("error", handlers.error);
        worker.off("exit", handlers.exit);
      };
    },
    terminate(): Promise<number> {
      return worker.terminate();
    },
  };
};
