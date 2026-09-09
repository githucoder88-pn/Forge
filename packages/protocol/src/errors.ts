/** Typed Forge error taxonomy. Serializable across the protocol. */

export const FORGE_ERROR_CODES = [
  "InvalidRequest",
  "NotFound",
  "PermissionDenied",
  "WorkspaceViolation",
  "ToolFailure",
  "ModelFailure",
  "ProviderUnavailable",
  "Timeout",
  "Cancelled",
  "PersistenceFailure",
  "ProtocolFailure",
  "Conflict",
  "RateLimited",
] as const;

export type ForgeErrorCode = (typeof FORGE_ERROR_CODES)[number];

/** JSON-RPC-ish numeric mapping (kept stable for protocol v1). */
const CODE_NUMBERS: Record<ForgeErrorCode, number> = {
  InvalidRequest: -32602,
  NotFound: -32001,
  PermissionDenied: -32002,
  WorkspaceViolation: -32003,
  ToolFailure: -32004,
  ModelFailure: -32005,
  ProviderUnavailable: -32006,
  Timeout: -32007,
  Cancelled: -32008,
  PersistenceFailure: -32009,
  ProtocolFailure: -32603,
  Conflict: -32010,
  RateLimited: -32011,
};

export interface ForgeErrorShape {
  code: ForgeErrorCode;
  codeNumber: number;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly codeNumber: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: ForgeErrorCode, message: string, opts?: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ForgeError";
    this.code = code;
    this.codeNumber = CODE_NUMBERS[code];
    this.details = opts?.details;
    this.retryable = opts?.retryable ?? (code === "Timeout" || code === "RateLimited" || code === "ProviderUnavailable");
  }

  toJSON(): ForgeErrorShape {
    return {
      code: this.code,
      codeNumber: this.codeNumber,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      retryable: this.retryable,
    };
  }

  static fromJSON(shape: ForgeErrorShape): ForgeError {
    return new ForgeError(shape.code, shape.message, { details: shape.details, retryable: shape.retryable });
  }

  static isForgeError(e: unknown): e is ForgeError {
    return e instanceof ForgeError;
  }

  /** Coerce arbitrary throws into a typed ForgeError (never leaks raw internals as contract). */
  static fromUnknown(e: unknown, fallback: ForgeErrorCode = "ProtocolFailure"): ForgeError {
    if (e instanceof ForgeError) return e;
    if (e instanceof Error) {
      const code = (e as Error & { code?: unknown }).code;
      if (code === "ENOENT") return new ForgeError("NotFound", e.message, { cause: e });
      if (code === "EACCES" || code === "EPERM") return new ForgeError("PermissionDenied", e.message, { cause: e });
      return new ForgeError(fallback, e.message, { cause: e });
    }
    return new ForgeError(fallback, String(e));
  }
}
