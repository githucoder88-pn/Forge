/** Predictable, typed error model shared by every subsystem. */

export type ForgeErrorCode =
  | 'PERMISSION_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_DENIED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'TOOL_FAILED'
  | 'MODEL_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'NO_PROVIDER'
  | 'RATE_LIMITED'
  | 'CONTEXT_OVERFLOW'
  | 'QUOTA_EXCEEDED'
  | 'DEPENDENCY_CYCLE'
  | 'DEADLOCK'
  | 'CHECKPOINT_FAILED'
  | 'PROVIDER_ERROR'
  | 'STORE_ERROR'
  | 'CONFIG_ERROR'
  | 'INTERNAL';

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly details?: Record<string, unknown>;
  readonly recoverable: boolean;

  constructor(code: ForgeErrorCode, message: string, opts?: { details?: Record<string, unknown>; recoverable?: boolean; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ForgeError';
    this.code = code;
    this.details = opts?.details;
    this.recoverable = opts?.recoverable ?? defaultRecoverable(code);
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details ?? null, recoverable: this.recoverable };
  }
}

function defaultRecoverable(code: ForgeErrorCode): boolean {
  switch (code) {
    case 'PERMISSION_DENIED':
    case 'APPROVAL_DENIED':
    case 'NOT_FOUND':
    case 'ALREADY_EXISTS':
    case 'INVALID_INPUT':
    case 'INVALID_STATE':
    case 'DEPENDENCY_CYCLE':
    case 'CANCELLED':
      return false;
    default:
      return true;
  }
}

export const isForgeError = (e: unknown): e is ForgeError => e instanceof ForgeError;

export function asForgeError(e: unknown, fallback: ForgeErrorCode = 'INTERNAL'): ForgeError {
  if (e instanceof ForgeError) return e;
  if (e instanceof Error) return new ForgeError(fallback, e.message, { cause: e });
  return new ForgeError(fallback, String(e));
}
