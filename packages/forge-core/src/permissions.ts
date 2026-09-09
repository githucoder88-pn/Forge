/**
 * Permissions: autonomy levels, approval policy, command classification,
 * path validation, and the human approval gate. Model-generated commands
 * are treated as untrusted intent — nothing bypasses policy invisibly.
 */
import { resolve, sep } from 'node:path';
import { ApprovalId, AgentId, approvalId, nowIso } from './ids.js';
import { ForgeError } from './errors.js';

export type AutonomyLevel = 'read-only' | 'workspace-write' | 'full-workspace' | 'unrestricted';
export type ApprovalPolicy = 'always' | 'on-risky-commands' | 'on-new-command' | 'never';
export type RiskClass = 'safe' | 'low' | 'risky' | 'destructive' | 'prohibited';

export const AUTONOMY_ORDER: AutonomyLevel[] = ['read-only', 'workspace-write', 'full-workspace', 'unrestricted'];

export function autonomyGte(have: AutonomyLevel, need: AutonomyLevel): boolean {
  return AUTONOMY_ORDER.indexOf(have) >= AUTONOMY_ORDER.indexOf(need);
}

export interface Classification {
  risk: RiskClass;
  reasons: string[];
}

/** Ordered destructive / prohibited patterns. First match wins for severity. */
const PATTERNS: { risk: RiskClass; re: RegExp; reason: string }[] = [
  { risk: 'prohibited', re: /(^|[\s;&|])(sudo|su|doas)\b/, reason: 'privilege escalation' },
  { risk: 'prohibited', re: /mkfs(\.|$|\s)|fdisk|parted|diskpart|format\s+[a-z]:/i, reason: 'disk formatting / partitioning' },
  { risk: 'prohibited', re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'fork bomb' },
  { risk: 'prohibited', re: /\bdd\b[^|]*of=\/dev\//, reason: 'raw disk write' },
  { risk: 'prohibited', re: /shutdown|reboot|halt|poweroff|init\s+[06]/i, reason: 'system power control' },
  { risk: 'prohibited', re: />\s*\/dev\/(sd|hd|nvme|disk)/, reason: 'raw device write' },
  { risk: 'destructive', re: /rm\s+[^|&;]*(-r[^|&;]*-f|-f[^|&;]*-r|--recursive[^|&;]*--force)/, reason: 'recursive forced delete' },
  { risk: 'destructive', re: /rm\s+(-[a-z]*r[a-z]*\s+|--recursive\s+)\/\s*( |$|;)/, reason: 'recursive delete of filesystem root' },
  { risk: 'destructive', re: /rm\s+-rf?\s+(~|\$HOME|\/|\/\*)/, reason: 'recursive delete of home/root' },
  { risk: 'destructive', re: /git\s+push\s+[^|&;]*--force/, reason: 'forced push rewrites shared history' },
  { risk: 'destructive', re: /git\s+(reset\s+--hard|clean\s+-[^\s]*f|branch\s+-D)/, reason: 'destructive git operation' },
  { risk: 'destructive', re: /DROP\s+(DATABASE|TABLE)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*;/i, reason: 'destructive database statement' },
  { risk: 'risky', re: /curl[^|&;]*\|\s*(ba)?sh|wget[^|&;]*\|\s*(ba)?sh/i, reason: 'piping remote content into a shell' },
  { risk: 'risky', re: /(kubectl|helm|terraform|fly|vercel|gcloud|aws)\s+(apply|deploy|delete|destroy|push|release)/i, reason: 'deployment / infrastructure mutation' },
  { risk: 'risky', re: /(apt|apt-get|yum|dnf|pacman|brew)\s+(install|remove|uninstall)\s+-y/i, reason: 'system-wide package change' },
  { risk: 'risky', re: /npm\s+(install|uninstall)\s+-g|pip(\s+install|\d*\s+install)\s+--(break-system-packages|target=\/)|gem\s+install/i, reason: 'global package installation' },
  { risk: 'risky', re: /chmod\s+-R\s+777|chown\s+-R/, reason: 'recursive permission/ownership change' },
  { risk: 'risky', re: /(\.ssh\/|\.aws\/credentials|\.gnupg\/|id_rsa|\.pem\b|Authorization:|x-api-key)/i, reason: 'credential material access' },
  { risk: 'risky', re: /env\s*\|\s*grep\s+-i\s*(key|token|secret|password)/i, reason: 'secret exfiltration pattern' },
  { risk: 'risky', re: /git\s+push\b/, reason: 'publishing commits to a remote' },
  { risk: 'low', re: /git\s+(commit|add|checkout|merge|rebase|stash|branch|tag)\b/, reason: 'local git mutation' },
  { risk: 'low', re: /(npm|yarn|pnpm|pip|pipenv|poetry|cargo|go|make|cmake|gradle|mvn)\s+(install|add|build|run|test|update|upgrade)\b/i, reason: 'package manager / build invocation' },
];

export function classifyCommand(command: string): Classification {
  const reasons: string[] = [];
  let worst: RiskClass = 'safe';
  const rank: Record<RiskClass, number> = { safe: 0, low: 1, risky: 2, destructive: 3, prohibited: 4 };
  for (const p of PATTERNS) {
    if (p.re.test(command)) {
      reasons.push(p.reason);
      if (rank[p.risk] > rank[worst]) worst = p.risk;
    }
  }
  return { risk: worst, reasons };
}

/**
 * Resolve `target` against workspace `root` and ensure it stays inside.
 * Throws PERMISSION_DENIED on escape attempts (including `..` traversal).
 */
export function resolveWorkspacePath(root: string, target: string): string {
  const absRoot = resolve(root);
  const abs = resolve(absRoot, target);
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) {
    throw new ForgeError('PERMISSION_DENIED', `Path escapes workspace root: ${target}`, {
      details: { root: absRoot, target },
    });
  }
  return abs;
}

export interface ApprovalRequest {
  id: ApprovalId;
  agentId?: AgentId;
  kind: 'command' | 'tool' | 'path' | 'git' | 'deploy';
  summary: string;
  detail?: Record<string, unknown>;
  risk: RiskClass;
  requestedAt: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  resolvedAt?: string;
}

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Human approval gate. Agents await `request()`; humans (CLI/Web) resolve via
 * `resolve()`. Timeouts deny by default (fail closed).
 */
export class ApprovalGate {
  private pending = new Map<string, PendingEntry>();
  private history: ApprovalRequest[] = [];
  private seenCommands = new Set<string>();
  private readonly timeoutMs: number;
  private onRequest?: (r: ApprovalRequest) => void;

  constructor(opts?: { timeoutMs?: number; onRequest?: (r: ApprovalRequest) => void }) {
    this.timeoutMs = opts?.timeoutMs ?? 120_000;
    this.onRequest = opts?.onRequest;
  }

  setOnRequest(fn: (r: ApprovalRequest) => void): void {
    this.onRequest = fn;
  }

  /** Decide whether a command needs approval under a policy (pure, testable). */
  needsApproval(command: string, policy: ApprovalPolicy, risk: RiskClass): boolean {
    switch (policy) {
      case 'always': return true;
      case 'never': return false;
      case 'on-new-command': {
        const key = command.trim();
        if (this.seenCommands.has(key)) return risk === 'destructive' || risk === 'prohibited';
        return true;
      }
      case 'on-risky-commands':
        return risk === 'risky' || risk === 'destructive' || risk === 'prohibited';
    }
  }

  markSeen(command: string): void {
    this.seenCommands.add(command.trim());
  }

  request(input: { agentId?: AgentId; kind: ApprovalRequest['kind']; summary: string; detail?: Record<string, unknown>; risk: RiskClass; timeoutMs?: number }): Promise<boolean> {
    const req: ApprovalRequest = {
      id: approvalId(),
      agentId: input.agentId,
      kind: input.kind,
      summary: input.summary,
      detail: input.detail,
      risk: input.risk,
      requestedAt: nowIso(),
      status: 'pending',
    };
    const timeout = input.timeoutMs ?? this.timeoutMs;
    return new Promise<boolean>((resolvePromise) => {
      const timer = timeout > 0
        ? setTimeout(() => this.settle(req.id, false, 'expired'), timeout)
        : undefined;
      this.pending.set(req.id, { request: req, resolve: resolvePromise, timer });
      this.history.push(req);
      if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
      this.onRequest?.(req);
    });
  }

  resolve(id: string, approved: boolean): ApprovalRequest {
    const entry = this.pending.get(id);
    if (!entry) {
      const past = this.history.find((h) => h.id === id);
      if (!past) throw new ForgeError('NOT_FOUND', `Approval ${id} not found`);
      return past;
    }
    return this.settle(id, approved, approved ? 'approved' : 'denied');
  }

  private settle(id: string, approved: boolean, status: ApprovalRequest['status']): ApprovalRequest {
    const entry = this.pending.get(id);
    if (!entry) throw new ForgeError('NOT_FOUND', `Approval ${id} not found`);
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.request.status = status;
    entry.request.resolvedAt = nowIso();
    entry.resolve(approved);
    return entry.request;
  }

  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => ({ ...p.request }));
  }

  getHistory(limit = 100): ApprovalRequest[] {
    return this.history.slice(-limit).map((h) => ({ ...h }));
  }

  pendingCount(): number { return this.pending.size; }
}

/** Redact likely secrets from tool output / logs before display or persistence. */
const SECRET_RES = [
  /(sk-(proj-)?[A-Za-z0-9_-]{16,})/g,
  /(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  /(gh[pousr]_[A-Za-z0-9_]{20,})/g,
  /(AIza[0-9A-Za-z_-]{20,})/g,
  /((?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*)(['"]?)([^\s'";,}]{4,})/gi,
  /(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/g,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_RES) {
    re.lastIndex = 0;
    out = out.replace(re, (...args: unknown[]) => {
      // Keep a short prefix (e.g. "Bearer ") while hiding the secret itself.
      const groups = args.slice(1, -2) as string[];
      if (groups.length >= 2 && groups[0] && groups[groups.length - 1]) {
        return `${groups.slice(0, -1).join('')}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return out;
}
