import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { ForgeError } from "@forge/protocol";
import { assertAllowed, checkShellCommand } from "./permissions.ts";
import type { ToolDefinition, ToolExecutionContext, ToolRegistry } from "./toolRegistry.ts";

export interface ProcessResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Production-grade process runner: streaming, timeout, cancellation, output
 * caps, no orphaned processes. Runs off the event loop (child_process).
 */
export function runProcess(
  command: string,
  opts: {
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
    maxBytes: number;
    onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
    env?: Record<string, string | undefined>;
  },
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const t0 = Date.now();
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child: ChildProcess = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      // Own process group on POSIX so cancellation kills the shell AND its
      // grandchildren (no orphans). No unref: we always await close/timeout.
      detached: process.platform !== "win32",
      env: { ...process.env, ...opts.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    timer.unref?.();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = (): void => {
      killTree(child);
      finish(() => reject(new ForgeError("Cancelled", `command cancelled: ${command.slice(0, 200)}`)));
    };
    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const append = (stream: "stdout" | "stderr", data: Buffer): void => {
      const text = data.toString("utf8");
      opts.onChunk?.(stream, text);
      if (outBytes + text.length > opts.maxBytes) {
        const room = Math.max(0, opts.maxBytes - outBytes);
        const piece = text.slice(0, room);
        if (stream === "stdout") stdout += piece;
        else stderr += piece;
        outBytes += piece.length;
        truncated = true;
        return;
      }
      if (stream === "stdout") stdout += text;
      else stderr += text;
      outBytes += text.length;
    };

    child.stdout?.on("data", (d: Buffer) => append("stdout", d));
    child.stderr?.on("data", (d: Buffer) => append("stderr", d));
    child.on("error", (e) => finish(() => reject(ForgeError.fromUnknown(e, "ToolFailure"))));
    child.on("close", (code, signal) => {
      finish(() => {
        if (timedOut) {
          reject(new ForgeError("Timeout", `command timed out after ${opts.timeoutMs}ms: ${command.slice(0, 200)}`));
          return;
        }
        resolve({
          command, cwd: opts.cwd, stdout, stderr,
          exitCode: code, signal: signal ?? null,
          durationMs: Date.now() - t0, truncated, timedOut: false,
        });
      });
    });
  });
}

function killTree(child: ChildProcess): void {
  try {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      // Terminate the whole tree on Windows.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      // Negative PID = whole process group (child is group leader via detached:true).
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        } catch {
          /* already dead */
        }
      }, 3000).unref?.();
    }
  } catch {
    /* best effort */
  }
}

function gitEnv(): Record<string, string> {
  return { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

async function detectTestCommand(ctx: ToolExecutionContext): Promise<{ command: string; kind: string }> {
  const ws = ctx.workspace;
  const readJson = async (p: string): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse((await ws.readFile(p, 64_000)).content) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const pkg = await readJson("package.json");
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    if (scripts.test && scripts.test !== "echo \"Error: no test specified\" && exit 1") {
      if (await ws.exists("pnpm-lock.yaml")) return { command: "pnpm test", kind: "pnpm" };
      if (await ws.exists("yarn.lock")) return { command: "yarn test", kind: "yarn" };
      if (await ws.exists("bun.lockb")) return { command: "bun test", kind: "bun" };
      return { command: "npm test -- --silent", kind: "npm" };
    }
  }
  if (await ws.exists("Cargo.toml")) return { command: "cargo test --quiet", kind: "cargo" };
  if (await ws.exists("go.mod")) return { command: "go test ./...", kind: "go" };
  if (await ws.exists("pytest.ini") || await ws.exists("pyproject.toml") || await ws.exists("tests")) {
    return { command: "python3 -m pytest -q", kind: "pytest" };
  }
  return { command: "npm test -- --silent", kind: "npm-fallback" };
}

async function detectBuildCommand(ctx: ToolExecutionContext): Promise<{ command: string; kind: string }> {
  const ws = ctx.workspace;
  try {
    const pkg = JSON.parse((await ws.readFile("package.json", 64_000)).content) as { scripts?: Record<string, string> };
    if (pkg.scripts?.build) return { command: "npm run build", kind: "npm" };
  } catch {
    /* ignore */
  }
  if (await ws.exists("Cargo.toml")) return { command: "cargo build --quiet", kind: "cargo" };
  if (await ws.exists("go.mod")) return { command: "go build ./...", kind: "go" };
  return { command: "npm run build", kind: "npm-fallback" };
}

async function runShellCommand(
  ctx: ToolExecutionContext,
  command: string,
  cwdRel: string | undefined,
  timeoutMs: number | undefined,
  eventKind: "command" | "test" | "build",
): Promise<ProcessResult> {
  const cwd = ctx.workspace.resolvePath(cwdRel ?? ".");
  ctx.agent.metrics.commandsRun++;
  const timeout = timeoutMs ?? ctx.config.limits.commandTimeoutMs;
  if (eventKind === "command") {
    ctx.bus.emit(ctx.sessionId, "command.started", { toolCallId: ctx.toolCallId, agentId: ctx.agent.id, tool: "execute_shell", command, cwd });
  }
  const release = ctx.acquireShellSlot ? await ctx.acquireShellSlot() : (): void => {};
  try {
    const res = await runProcess(command, {
      cwd,
      timeoutMs: timeout,
      signal: ctx.signal,
      maxBytes: ctx.config.limits.maxOutputBytes,
      env: gitEnv(),
      onChunk: (_stream, chunk) => {
        ctx.emitChunk(chunk);
        if (eventKind === "command") {
          ctx.bus.emit(ctx.sessionId, "command.output", { toolCallId: ctx.toolCallId, agentId: ctx.agent.id, tool: "execute_shell", command, cwd, chunk: chunk.slice(0, 8000) });
        }
      },
    });
    if (eventKind === "command") {
      ctx.bus.emit(ctx.sessionId, res.exitCode === 0 ? "command.completed" : "command.failed", {
        toolCallId: ctx.toolCallId, agentId: ctx.agent.id, tool: "execute_shell",
        command, cwd, exitCode: res.exitCode ?? -1, durationMs: res.durationMs,
        result: { stdoutTail: res.stdout.slice(-4000), stderrTail: res.stderr.slice(-4000) },
      });
    }
    return res;
  } finally {
    release();
  }
}

export function registerExecTools(registry: ToolRegistry): void {
  const shellInput = z.object({
    command: z.string().min(1).max(8000),
    cwd: z.string().max(1024).optional(),
    timeoutMs: z.number().int().min(100).max(1_800_000).optional(),
  });

  const defs: ToolDefinition[] = [
    {
      name: "execute_shell",
      description: "Run a shell command in the workspace. Output is streamed and truncated. Prefer targeted commands; destructive binaries are denied by policy.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Workspace-relative working directory" },
          timeoutMs: { type: "integer" },
        },
        required: ["command"],
      },
      input: shellInput,
      async execute(ctx) {
        const { command, cwd, timeoutMs } = ctx.input as { command: string; cwd?: string; timeoutMs?: number };
        const res = await runShellCommand(ctx, command, cwd, timeoutMs, "command");
        return {
          command: res.command, cwd: ctx.workspace.displayPath(res.cwd),
          exitCode: res.exitCode, durationMs: res.durationMs, truncated: res.truncated,
          stdout: res.stdout.slice(-12000), stderr: res.stderr.slice(-12000),
          success: res.exitCode === 0,
        };
      },
    },
    {
      name: "git_status",
      description: "Show git working-tree status (branch + porcelain list).",
      parameters: { type: "object", properties: {} },
      input: z.object({}),
      async execute(ctx) {
        const res = await runShellCommand(ctx, "git status --porcelain=v1 -b", ".", 15_000, "command");
        return { success: res.exitCode === 0, output: (res.stdout + res.stderr).slice(0, 8000) };
      },
    },
    {
      name: "git_diff",
      description: "Show git diff (unstaged by default; staged=true for cached).",
      parameters: {
        type: "object",
        properties: { staged: { type: "boolean" }, path: { type: "string" } },
        required: [],
      },
      input: z.object({ staged: z.boolean().optional(), path: z.string().max(1024).optional() }),
      async execute(ctx) {
        const { staged, path } = ctx.input as { staged?: boolean; path?: string };
        let cmd = staged ? "git diff --cached" : "git diff";
        if (path) {
          const abs = ctx.workspace.resolvePath(path); // validate jail even for git paths
          cmd += ` -- "${abs}"`;
        }
        const res = await runShellCommand(ctx, cmd, ".", 15_000, "command");
        return { success: res.exitCode === 0, diff: (res.stdout || res.stderr).slice(0, 20000), truncated: res.truncated };
      },
    },
    {
      name: "git_log",
      description: "Show recent commit history (oneline).",
      parameters: { type: "object", properties: { limit: { type: "integer" } }, required: [] },
      input: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      async execute(ctx) {
        const { limit } = ctx.input as { limit?: number };
        const res = await runShellCommand(ctx, `git log --oneline -n ${limit ?? 10}`, ".", 15_000, "command");
        return { success: res.exitCode === 0, log: (res.stdout || res.stderr).slice(0, 8000) };
      },
    },
    {
      name: "run_tests",
      description: "Run the repository test suite (auto-detects npm/cargo/go/pytest). Reports structured pass/fail — never claims success unless the command exits 0.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer" } },
        required: [],
      },
      input: z.object({ command: z.string().max(8000).optional(), cwd: z.string().max(1024).optional(), timeoutMs: z.number().int().min(100).max(1_800_000).optional() }),
      timeoutMs: 600_000,
      async execute(ctx) {
        const { command, cwd, timeoutMs } = ctx.input as { command?: string; cwd?: string; timeoutMs?: number };
        const detected = command ? { command, kind: "explicit" } : await detectTestCommand(ctx);
        assertAllowed(checkShellCommand(ctx.agent.permissions, detected.command));
        ctx.agent.metrics.testsRun++;
        ctx.bus.emit(ctx.sessionId, "test.started", { agentId: ctx.agent.id, command: detected.command });
        const t0 = Date.now();
        try {
          const res = await runShellCommand(ctx, detected.command, cwd, timeoutMs, "test");
          const passed = res.exitCode === 0;
          ctx.bus.emit(ctx.sessionId, passed ? "test.passed" : "test.failed", {
            agentId: ctx.agent.id, command: detected.command, passed, exitCode: res.exitCode ?? -1,
            durationMs: Date.now() - t0,
            summary: passed ? "tests passed" : `tests failed (exit ${res.exitCode})`,
          });
          return {
            command: detected.command, detector: detected.kind, passed, exitCode: res.exitCode,
            durationMs: res.durationMs, stdout: res.stdout.slice(-12000), stderr: res.stderr.slice(-12000), success: passed,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ctx.bus.emit(ctx.sessionId, "test.failed", { agentId: ctx.agent.id, command: detected.command, passed: false, summary: msg, durationMs: Date.now() - t0 });
          throw e;
        }
      },
    },
    {
      name: "run_build",
      description: "Run the repository build (auto-detects npm/cargo/go). Reports structured success/failure.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer" } },
        required: [],
      },
      input: z.object({ command: z.string().max(8000).optional(), cwd: z.string().max(1024).optional(), timeoutMs: z.number().int().min(100).max(1_800_000).optional() }),
      timeoutMs: 600_000,
      async execute(ctx) {
        const { command, cwd, timeoutMs } = ctx.input as { command?: string; cwd?: string; timeoutMs?: number };
        const detected = command ? { command, kind: "explicit" } : await detectBuildCommand(ctx);
        assertAllowed(checkShellCommand(ctx.agent.permissions, detected.command));
        const res = await runShellCommand(ctx, detected.command, cwd, timeoutMs, "build");
        const ok = res.exitCode === 0;
        return {
          command: detected.command, detector: detected.kind, success: ok, exitCode: res.exitCode,
          durationMs: res.durationMs, stdout: res.stdout.slice(-12000), stderr: res.stderr.slice(-12000),
        };
      },
    },
  ];
  for (const d of defs) registry.register(d);
}
