import type { JsonValue } from './schema';

export interface RuntimeIssue {
  code: string;
  message: string;
  path?: (string | number)[];
  details?: JsonValue;
}

export class ExecutionError extends Error {
  constructor(readonly issue: RuntimeIssue) {
    super(issue.message);
    this.name = 'ExecutionError';
  }
}

export function executionError(
  code: string,
  message: string,
  path?: (string | number)[],
  details?: JsonValue,
) {
  return new ExecutionError({
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(details === undefined ? {} : { details }),
  });
}

export function errorIssue(error: unknown): RuntimeIssue {
  return error instanceof ExecutionError
    ? error.issue
    : {
        code: 'UNEXPECTED_ERROR',
        message: error instanceof Error ? error.message : String(error),
      };
}

export function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}

/** Also stops awaiting an injected adapter that fails to cooperate with abort. */
export async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const finish = () => {
      const remaining = ms - (performance.now() - started);
      if (remaining > 0)
        timer = setTimeout(finish, Math.min(remaining, 2_147_483_647));
      else {
        signal.removeEventListener('abort', abort);
        resolve();
      }
    };
    timer = setTimeout(finish, Math.min(ms, 2_147_483_647));
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Chunk long deadlines instead of allowing Node's 32-bit timer overflow.
export function deadline(
  ms: number,
  error: ExecutionError,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout>;
  function schedule() {
    const remaining = ms - (performance.now() - started);
    if (remaining <= 0) controller.abort(error);
    else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
  }
  schedule();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
