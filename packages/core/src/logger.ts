/** Structured logger with secret redaction. JSON lines to stderr. */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /sk-proj-[A-Za-z0-9_-]{8,}/g,
  // Assignment-shaped only (requires : or =) so prose like
  // "OPENAI_API_KEY is not set" is never mangled.
  /(api[_-]?key\s*[:=]\s*["']?)([^\s"',}]+)/gi,
  /(authorization["'\s:=]+bearer\s+)([^\s"',}]+)/gi,
  /(x-api-key\s*[:=]\s*["']?)([^\s"',}]+)/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (_m, prefix?: string) => (prefix !== undefined ? `${prefix}[REDACTED]` : "[REDACTED]"));
  }
  return out;
}

export interface LogContext {
  sessionId?: string;
  agentId?: string;
  toolCallId?: string;
  eventId?: string;
  provider?: string;
  model?: string;
  [k: string]: unknown;
}

export class Logger {
  private level: number;
  private base: LogContext;
  constructor(level: LogLevel = "info", base: LogContext = {}) {
    this.level = RANK[level];
    this.base = base;
  }
  setLevel(l: LogLevel): void {
    this.level = RANK[l];
  }
  private emit(level: LogLevel, msg: string, ctx?: LogContext): void {
    if (RANK[level] < this.level) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...this.base, ...ctx });
    process.stderr.write(redactSecrets(line) + "\n");
  }
  trace(msg: string, ctx?: LogContext): void {
    this.emit("trace", msg, ctx);
  }
  debug(msg: string, ctx?: LogContext): void {
    this.emit("debug", msg, ctx);
  }
  info(msg: string, ctx?: LogContext): void {
    this.emit("info", msg, ctx);
  }
  warn(msg: string, ctx?: LogContext): void {
    this.emit("warn", msg, ctx);
  }
  error(msg: string, ctx?: LogContext): void {
    this.emit("error", msg, ctx);
  }
  child(base: LogContext): Logger {
    const c = new Logger("trace", { ...this.base, ...base });
    c.level = this.level;
    return c;
  }
}

let shared: Logger | null = null;
export function getLogger(level?: LogLevel): Logger {
  if (!shared) shared = new Logger(level ?? "info");
  else if (level) shared.setLevel(level);
  return shared;
}
