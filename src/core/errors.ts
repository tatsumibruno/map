/**
 * A user-facing error: the CLI prints `message` (plus `hint`) and exits with
 * `exitCode` instead of dumping a stack trace.
 */
export class AgentctlError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(
    message: string,
    options: { code?: string; hint?: string; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgentctlError';
    this.code = options.code ?? 'E_GENERIC';
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

export class ValidationError extends AgentctlError {
  constructor(message: string, hint?: string) {
    super(message, { code: 'E_VALIDATION', exitCode: 2, ...(hint ? { hint } : {}) });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AgentctlError {
  constructor(message: string, hint?: string) {
    super(message, { code: 'E_NOT_FOUND', exitCode: 3, ...(hint ? { hint } : {}) });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AgentctlError {
  constructor(message: string, hint?: string) {
    super(message, { code: 'E_CONFLICT', exitCode: 4, ...(hint ? { hint } : {}) });
    this.name = 'ConflictError';
  }
}

export class TransportError extends AgentctlError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'E_TRANSPORT', exitCode: 5, ...options });
    this.name = 'TransportError';
  }
}

export function isAgentctlError(value: unknown): value is AgentctlError {
  return value instanceof AgentctlError;
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
