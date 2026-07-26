import type { UciTransport } from "./types.js";
import { UciProtocolError } from "./types.js";

export interface MockUciStep {
  readonly command: string | RegExp;
  readonly responses?: readonly string[];
  readonly closeAfter?: boolean;
  readonly onSend?: () => void | Promise<void>;
}

interface PendingRead {
  readonly resolve: (result: IteratorResult<string>) => void;
}

export class MockUciTransport implements UciTransport {
  readonly #steps: readonly MockUciStep[];
  readonly #commands: string[] = [];
  readonly #lines: string[] = [];
  readonly #readers: PendingRead[] = [];
  #stepIndex = 0;
  #closed = false;

  public constructor(steps: readonly MockUciStep[]) {
    this.#steps = [...steps];
  }

  public get commands(): readonly string[] {
    return [...this.#commands];
  }

  public get complete(): boolean {
    return this.#stepIndex === this.#steps.length;
  }

  public async send(command: string): Promise<void> {
    if (this.#closed) {
      throw new UciProtocolError("Cannot send to a closed mock transport.");
    }
    const step = this.#steps[this.#stepIndex];
    if (step === undefined) {
      throw new UciProtocolError(`Unexpected UCI command: ${command}`);
    }
    const matches = typeof step.command === "string"
      ? command === step.command
      : step.command.test(command);
    if (!matches) {
      throw new UciProtocolError(
        `Expected UCI command "${String(step.command)}", received "${command}".`,
      );
    }
    this.#commands.push(command);
    this.#stepIndex += 1;
    await step.onSend?.();
    for (const response of step.responses ?? []) {
      this.#enqueue(response);
    }
    if (step.closeAfter === true) {
      this.#finish();
    }
  }

  public lines(): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.#read(),
      }),
    };
  }

  public close(): Promise<void> {
    this.#finish();
    return Promise.resolve();
  }

  #enqueue(line: string): void {
    const reader = this.#readers.shift();
    if (reader === undefined) {
      this.#lines.push(line);
    } else {
      reader.resolve({ done: false, value: line });
    }
  }

  #read(): Promise<IteratorResult<string>> {
    const line = this.#lines.shift();
    if (line !== undefined) {
      return Promise.resolve({ done: false, value: line });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => {
      this.#readers.push({ resolve });
    });
  }

  #finish(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) {
      reader.resolve({ done: true, value: undefined });
    }
  }
}
