import { ForgeError, type AgentPermissions, type ApprovalPolicy, type PermissionMode } from "@forge/protocol";

/** Risk classification for built-in tools. */
export type ToolRisk = "read" | "write" | "exec" | "destructive";

const TOOL_RISK: Record<string, ToolRisk> = {
  read_file: "read",
  list_directory: "read",
  search_files: "read",
  git_status: "read",
  git_diff: "read",
  git_log: "read",
  write_file: "write",
  edit_file: "write",
  create_file: "write",
  delete_file: "destructive",
  execute_shell: "exec",
  run_tests: "exec",
  run_build: "exec",
};

export function toolRisk(tool: string): ToolRisk {
  return TOOL_RISK[tool] ?? "exec";
}

/** Binaries that are never executed regardless of mode (irreversible / exfiltration-prone). */
const ALWAYS_DENIED = new Set([
  "rm", "rmdir", "mkfs", "dd", "shutdown", "reboot", "poweroff", "halt",
  "chmod", "chown", // avoid permission-escalation footguns in phase 1
  "curl", "wget", // no network fetch from shell in phase 1 default
  "ssh", "scp", "ftp", "telnet",
  "nc", "ncat", "socat",
  "eval",
]);

/** Safe default allowlist for workspace-write mode (dev commands). */
const DEFAULT_ALLOWED = new Set([
  "ls", "cat", "head", "tail", "wc", "echo", "pwd", "true", "false", "sleep",
  "git", "node", "npm", "npx", "pnpm", "yarn", "bun", "deno",
  "tsc", "tsx", "vitest", "jest", "pytest", "python", "python3", "pip",
  "go", "cargo", "rustc", "make", "cmake",
  "grep", "rg", "find", "sed", "awk", "diff", "sort", "uniq",
  "mkdir", "touch", "cp", "mv",
]);

export interface PermissionCheck {
  allowed: boolean;
  needsApproval: boolean;
  reason: string;
}

export function firstToken(command: string): string {
  const t = command.trim().split(/\s+/, 1)[0] ?? "";
  // strip env assignments (FOO=bar cmd) and sudo
  if (t.includes("=") || t === "sudo" || t === "env") {
    const parts = command.trim().split(/\s+/);
    for (const part of parts) {
      if (part === "sudo" || part === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) continue;
      return part.split("/").pop() ?? part;
    }
    return t;
  }
  return t.split("/").pop() ?? t;
}

/**
 * Core permission engine. Clients NEVER enforce security — every tool call and
 * every shell command passes through here in the Core.
 */
export function checkToolPermission(perms: AgentPermissions, tool: string, input: unknown): PermissionCheck {
  const risk = toolRisk(tool);
  const mode: PermissionMode = perms.mode;
  const approval: ApprovalPolicy = perms.approval;

  if (mode === "read-only" && (risk === "write" || risk === "exec" || risk === "destructive")) {
    return { allowed: false, needsApproval: false, reason: `tool '${tool}' requires write permission (mode is read-only)` };
  }
  if (mode === "workspace-write" && risk === "destructive") {
    // delete_file needs explicit approval in workspace-write
    if (approval === "never") return { allowed: false, needsApproval: false, reason: `tool '${tool}' is destructive and approvals are disabled` };
    return { allowed: true, needsApproval: true, reason: `tool '${tool}' is destructive` };
  }

  if (tool === "execute_shell" || tool === "run_tests" || tool === "run_build") {
    const cmd = typeof input === "object" && input !== null ? String((input as Record<string, unknown>).command ?? "") : "";
    if (!cmd.trim() && tool !== "execute_shell") {
      // run_tests/run_build auto-detect a dev command; the concrete command is
      // vetted by checkShellCommand at execution time (see execTools).
      return { allowed: true, needsApproval: false, reason: "auto-detected command (vetted at execution)" };
    }
    return checkShellCommand(perms, cmd);
  }

  if (risk === "destructive" && approval === "always") {
    return { allowed: true, needsApproval: true, reason: `tool '${tool}' is destructive` };
  }
  if (approval === "always" && risk !== "read") {
    return { allowed: true, needsApproval: true, reason: `approval policy is 'always'` };
  }
  if (approval === "risky-only" && (risk === "destructive" || risk === "exec")) {
    // exec commands were already individually vetted above; destructive needs approval
    if (risk === "destructive") return { allowed: true, needsApproval: true, reason: `tool '${tool}' is destructive` };
  }
  return { allowed: true, needsApproval: false, reason: "ok" };
}

export function checkShellCommand(perms: AgentPermissions, command: string): PermissionCheck {
  if (!command.trim()) return { allowed: false, needsApproval: false, reason: "empty command" };
  // Block command chaining tricks that smuggle denied binaries? Phase-1 approach:
  // split on shell operators and vet EVERY segment's binary.
  const segments = command.split(/&&|\|\||[|;]|\$\(|`/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    // Privilege-escalation wrappers are never allowed in Phase 1.
    if (/^(sudo|su|doas|runuser)\b/i.test(seg)) {
      return { allowed: false, needsApproval: false, reason: "privilege-escalation wrappers (sudo/su/doas) are denied by policy" };
    }
    const bin = firstToken(seg).toLowerCase();
    if (!bin) continue;
    if (ALWAYS_DENIED.has(bin)) {
      return { allowed: false, needsApproval: false, reason: `binary '${bin}' is denied by policy` };
    }
    if (perms.denyCommands?.map((d) => d.toLowerCase()).includes(bin)) {
      return { allowed: false, needsApproval: false, reason: `binary '${bin}' is denied by session policy` };
    }
    if (perms.mode === "full-workspace") continue;
    const allowed = perms.allowCommands?.map((a) => a.toLowerCase()) ?? [];
    if (!DEFAULT_ALLOWED.has(bin) && !allowed.includes(bin)) {
      if (perms.approval === "never") {
        return { allowed: false, needsApproval: false, reason: `binary '${bin}' is not in the allowed set and approvals are disabled` };
      }
      return { allowed: true, needsApproval: true, reason: `binary '${bin}' is not in the default allowed set` };
    }
  }
  if (perms.approval === "always") return { allowed: true, needsApproval: true, reason: "approval policy is 'always'" };
  return { allowed: true, needsApproval: false, reason: "ok" };
}

export function assertAllowed(check: PermissionCheck): void {
  if (!check.allowed) throw new ForgeError("PermissionDenied", check.reason);
}
