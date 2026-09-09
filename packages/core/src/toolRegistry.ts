import { z } from "zod";
import {
  createApprovalId,
  createToolCallId,
  ForgeError,
  type Agent,
  type AgentId,
  type EventId,
  type SessionId,
  type ToolCallId,
} from "@forge/protocol";
import type { ForgeConfig } from "./config.ts";
import type { EventBus } from "./eventBus.ts";
import type { Logger } from "./logger.ts";
import { checkToolPermission, assertAllowed } from "./permissions.ts";
import type { Store } from "./store.ts";
import type { Workspace } from "./workspace.ts";

export interface ToolContext {
  sessionId: SessionId;
  agent: Agent;
  workspace: Workspace;
  bus: EventBus;
  store: Store;
  log: Logger;
  config: ForgeConfig;
  /** Resolve an approval gate. Returns true when approved. */
  requestApproval: (info: { approvalId: string; tool: string; input: unknown; reason: string; toolCallId: ToolCallId }) => Promise<boolean>;
  /** Bound concurrent shell processes (wired by the session runtime). */
  acquireShellSlot?: () => Promise<() => void>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) shown to the model. */
  parameters: Record<string, unknown>;
  /** zod schema for Core-side validation (never trust the model). */
  input: z.ZodTypeAny;
  timeoutMs?: number;
  execute: (ctx: ToolExecutionContext) => Promise<unknown>;
}

export interface ToolExecutionContext extends ToolContext {
  toolCallId: ToolCallId;
  /** Validated tool input (zod-parsed by the registry). */
  input: unknown;
  signal: AbortSignal;
  /** Stream a bounded output chunk (emits tool.output). */
  emitChunk: (chunk: string) => void;
}

export interface ToolResult {
  toolCallId: ToolCallId;
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

function semaphore(max: number): { acquire: () => Promise<() => void> } {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    acquire: () =>
      new Promise((resolve) => {
        const tryTake = (): void => {
          if (active < max) {
            active++;
            resolve(() => {
              active--;
              const next = queue.shift();
              if (next) next();
            });
          } else queue.push(tryTake);
        };
        tryTake();
      }),
  };
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private toolSlots: { acquire: () => Promise<() => void> };
  private shellSlots: { acquire: () => Promise<() => void> };

  private config: ForgeConfig;
  constructor(config: ForgeConfig) {
    this.config = config;
    this.toolSlots = semaphore(config.limits.maxConcurrentTools);
    this.shellSlots = semaphore(config.limits.maxShellProcesses);
  }

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) throw new Error(`tool already registered: ${def.name}`);
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition {
    const t = this.tools.get(name);
    if (!t) throw new ForgeError("NotFound", `unknown tool: ${name}`);
    return t;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** OpenAI-style function specs for the model. Read-only tools first (nudge safe behavior). */
  functionSpecs(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  async acquireShellSlot(): Promise<() => void> {
    return this.shellSlots.acquire();
  }

  /**
   * Full execution pipeline: validate -> permissions -> approval -> execute
   * (timeout/cancel/semaphore) -> events -> persistence. Never throws for tool
   * logic failures — those become `{ok:false}` results; throws only for
   * permission/cancellation/protocol violations.
   */
  async execute(ctx: ToolContext, tool: string, rawInput: unknown, signal: AbortSignal): Promise<ToolResult> {
    const def = this.get(tool);
    const parsed = def.input.safeParse(rawInput);
    if (!parsed.success) {
      throw new ForgeError("InvalidRequest", `invalid input for tool '${tool}': ${parsed.error.message}`);
    }
    const toolCallId = createToolCallId();
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const log = ctx.log.child({ sessionId: ctx.sessionId, agentId: ctx.agent.id, toolCallId });

    // Permissions (Core-enforced).
    const check = checkToolPermission(ctx.agent.permissions, tool, parsed.data);
    assertAllowed(check);
    if (check.needsApproval) {
      const approvalId = createApprovalId();
      ctx.store.saveApproval({
        id: approvalId, sessionId: ctx.sessionId, agentId: ctx.agent.id,
        tool, input: parsed.data, reason: check.reason, status: "pending", createdAt: startedAt,
      });
      ctx.bus.emit(ctx.sessionId, "approval.requested", { approvalId, tool, reason: check.reason, input: parsed.data });
      log.info(`awaiting approval for ${tool}: ${check.reason}`, { tool });
      const approved = await ctx.requestApproval({ approvalId, tool, input: parsed.data, reason: check.reason, toolCallId });
      ctx.store.saveApproval({
        id: approvalId, sessionId: ctx.sessionId, agentId: ctx.agent.id,
        tool, input: parsed.data, reason: check.reason,
        status: approved ? "approved" : "denied",
        createdAt: startedAt, resolvedAt: new Date().toISOString(),
      });
      ctx.bus.emit(ctx.sessionId, "approval.resolved", { approvalId, approved });
      if (!approved) throw new ForgeError("PermissionDenied", `operation denied by approver: ${tool} — ${check.reason}`);
    }

    throwIfAborted(signal, tool);
    const release = await this.toolSlots.acquire();
    const startedEvt = ctx.bus.emit(ctx.sessionId, "tool.started", { toolCallId, agentId: ctx.agent.id, tool });
    const causation: EventId = startedEvt.id;
    let chunkBytes = 0;
    const maxChunk = ctx.config.limits.maxOutputBytes;
    const emitChunk = (chunk: string): void => {
      if (!chunk) return;
      chunkBytes += chunk.length;
      if (chunkBytes > maxChunk + 50_000) return; // hard stop on runaway streams
      ctx.bus.emit(ctx.sessionId, "tool.output", {
        toolCallId, agentId: ctx.agent.id, tool,
        chunk: chunk.length > 8000 ? chunk.slice(0, 8000) + "\n…[truncated]" : chunk,
      }, causation);
    };

    const timeoutMs = def.timeoutMs ?? ctx.config.limits.commandTimeoutMs;
    const execCtx: ToolExecutionContext = { ...ctx, toolCallId, input: parsed.data, signal, emitChunk };
    ctx.store.saveToolRun({ id: toolCallId, sessionId: ctx.sessionId, agentId: ctx.agent.id, tool, input: parsed.data, ok: false, startedAt });

    try {
      const result = await withTimeout(def.execute(execCtx), timeoutMs, tool, signal);
      const durationMs = Date.now() - t0;
      const slim = slimResult(result, maxChunk);
      ctx.bus.emit(ctx.sessionId, "tool.completed", { toolCallId, agentId: ctx.agent.id, tool, ok: true, durationMs, result: slim }, causation);
      ctx.store.saveToolRun({ id: toolCallId, sessionId: ctx.sessionId, agentId: ctx.agent.id, tool, input: parsed.data, ok: true, output: slim, startedAt, endedAt: new Date().toISOString() });
      log.info(`tool ${tool} ok in ${durationMs}ms`, { tool });
      return { toolCallId, tool, ok: true, result, durationMs };
    } catch (e) {
      const durationMs = Date.now() - t0;
      if (e instanceof ForgeError && (e.code === "Cancelled" || e.code === "PermissionDenied" || e.code === "WorkspaceViolation")) {
        ctx.bus.emit(ctx.sessionId, "tool.failed", { toolCallId, agentId: ctx.agent.id, tool, ok: false, durationMs, error: e.message }, causation);
        ctx.store.saveToolRun({ id: toolCallId, sessionId: ctx.sessionId, agentId: ctx.agent.id, tool, input: parsed.data, ok: false, error: e.message, startedAt, endedAt: new Date().toISOString() });
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      ctx.bus.emit(ctx.sessionId, "tool.failed", { toolCallId, agentId: ctx.agent.id, tool, ok: false, durationMs, error: msg }, causation);
      ctx.store.saveToolRun({ id: toolCallId, sessionId: ctx.sessionId, agentId: ctx.agent.id, tool, input: parsed.data, ok: false, error: msg, startedAt, endedAt: new Date().toISOString() });
      log.warn(`tool ${tool} failed: ${msg}`, { tool });
      return { toolCallId, tool, ok: false, error: msg, durationMs };
    } finally {
      release();
    }
  }
}

export function throwIfAborted(signal: AbortSignal, what: string): void {
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "cancelled");
    throw new ForgeError("Cancelled", `${what} cancelled: ${reason}`);
  }
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number, tool: string, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ForgeError("Timeout", `tool '${tool}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ForgeError("Cancelled", `tool '${tool}' cancelled`));
    };
    if (signal.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Bound persisted/emitted result size without mutating the live value. */
function slimResult(result: unknown, maxBytes: number): unknown {
  try {
    const s = JSON.stringify(result);
    if (s.length <= maxBytes) return result;
    return { _truncated: true, bytes: s.length, preview: s.slice(0, Math.min(8000, maxBytes)) };
  } catch {
    return { _unserializable: true };
  }
}
