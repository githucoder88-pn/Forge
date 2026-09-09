import {
  createMessageId,
  createTaskId,
  createToolCallId,
  ForgeError,
  type Agent,
  type AgentId,
  type Session,
} from "@forge/protocol";
import type { ForgeConfig } from "./config.ts";
import { buildContext } from "./context.ts";
import type { EventBus } from "./eventBus.ts";
import type { Logger } from "./logger.ts";
import { createProvider, type ModelProvider, type ModelResponse, type StreamEvent } from "./models.ts";
import { isTerminal, transition } from "./agent.ts";
import type { Store } from "./store.ts";
import { throwIfAborted, type ToolContext, type ToolRegistry } from "./toolRegistry.ts";
import { Workspace } from "./workspace.ts";

export interface AgentRuntimeOpts {
  store: Store;
  bus: EventBus;
  registry: ToolRegistry;
  config: ForgeConfig;
  log: Logger;
  /** Provider factory (lets tests inject deterministic doubles). */
  getProvider?: (session: Session, agent: Agent) => ModelProvider;
  /** Auto-approve approval gates (CLI --yes). Default false. */
  autoApprove?: boolean;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  tool: string;
  reason: string;
}

/**
 * The Phase-1 coding-agent loop:
 * user request -> context -> model -> tool calls -> execute -> model ... -> final answer.
 * Iterative, cancellable, bounded, fully evented.
 */
export class AgentRuntime {
  private running = new Map<AgentId, AbortController>();
  private pendingApprovals = new Map<string, PendingApproval>();

  private opts: AgentRuntimeOpts;
  constructor(opts: AgentRuntimeOpts) {
    this.opts = opts;
  }

  isRunning(agentId: AgentId): boolean {
    return this.running.has(agentId);
  }

  cancel(agentId: AgentId, reason = "cancelled by user"): boolean {
    const c = this.running.get(agentId);
    if (!c) return false;
    c.abort(new Error(reason));
    return true;
  }

  /** Resolve an approval gate (wired to the `resolve_approval` RPC). */
  resolveApproval(approvalId: string, approved: boolean): boolean {
    const p = this.pendingApprovals.get(approvalId);
    if (!p) {
      // Might already be resolved/persisted — check store for idempotency.
      const rec = this.opts.store.getApproval(approvalId);
      return rec !== null && rec.status !== "pending";
    }
    this.pendingApprovals.delete(approvalId);
    p.resolve(approved);
    return true;
  }

  buildToolContext(session: Session, agent: Agent, workspace: Workspace): ToolContext {
    return {
      sessionId: session.id,
      agent,
      workspace,
      bus: this.opts.bus,
      store: this.opts.store,
      log: this.opts.log,
      config: this.opts.config,
      acquireShellSlot: () => this.opts.registry.acquireShellSlot(),
      requestApproval: async ({ approvalId, tool, reason }) => {
        if (this.opts.autoApprove) return true;
        // Wait for an external resolve_approval RPC (10 min cap, then deny).
        // Waiters are keyed by the domain ApprovalId so RPC resolution correlates.
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            this.pendingApprovals.delete(approvalId);
            resolve(false);
          }, 10 * 60_000);
          timer.unref?.();
          this.pendingApprovals.set(approvalId, {
            tool,
            reason,
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
          });
        });
      },
    };
  }

  /**
   * Run an agent to completion against `task`. Resolves with the final summary.
   * The loop is re-entrant per agent but never concurrent (second run throws Conflict).
   */
  async run(agentId: AgentId, task: string, parentSignal?: AbortSignal): Promise<string> {
    const { store, bus, config, log } = this.opts;
    if (this.running.has(agentId)) throw new ForgeError("Conflict", `agent ${agentId} is already running`);
    const agent = store.getAgent(agentId);
    if (!agent) throw new ForgeError("NotFound", `agent not found: ${agentId}`);
    const session = store.getSession(agent.sessionId);
    if (!session) throw new ForgeError("NotFound", `session not found: ${agent.sessionId}`);

    const controller = new AbortController();
    this.running.set(agentId, controller);
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal;

    const taskId = createTaskId();
    const startedAt = Date.now();
    const maxIterations = session.config.maxIterations || config.limits.maxIterations;
    const workspace = new Workspace(session.workspaceRoot);
    const provider = this.opts.getProvider ? this.opts.getProvider(session, agent) : createProvider(session.config.provider, config, log);
    const toolCtx = this.buildToolContext(session, agent, workspace);
    const setState = (to: Agent["state"], reason?: string): void => {
      const { from } = transition(agent, to, reason);
      agent.updatedAt = new Date().toISOString();
      store.saveAgent(agent);
      bus.emit(session.id, "agent.state_changed", { agentId: agent.id, from, to, reason });
    };

    try {
      if (isTerminal(agent.state)) throw new ForgeError("InvalidRequest", `agent is terminal (${agent.state})`);
      if (agent.state === "created") setState("idle", "run started");
      if (agent.state === "idle") setState("planning", task.slice(0, 200));

      store.saveTask({ id: taskId, sessionId: session.id, agentId: agent.id, title: task.slice(0, 500), status: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      agent.currentTask = taskId;
      store.saveAgent(agent);

      // Persist the user request.
      const userMsgId = createMessageId();
      store.saveMessage({ id: userMsgId, sessionId: session.id, agentId: null, role: "user", content: task, createdAt: new Date().toISOString() });
      bus.emit(session.id, "message.user", { messageId: userMsgId, role: "user", content: task });

      bus.emit(session.id, "agent.started", { agentId: agent.id, task: task.slice(0, 2000) });
      setState("executing", "planning complete");

      const history = store.listMessages(session.id);
      const toolResults: { toolCallId: string; tool: string; output: string }[] = [];
      const sessionMsgs: { role: "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: { id: string; tool: string; input: unknown }[] }[] = [];
      let iterations = 0;
      let finalText = "";

      while (iterations < maxIterations) {
        throwIfAborted(signal, `agent ${agent.id}`);
        if (Date.now() - startedAt > config.limits.maxAgentRuntimeMs) {
          throw new ForgeError("Timeout", `agent exceeded max runtime (${config.limits.maxAgentRuntimeMs}ms)`);
        }
        iterations++;
        agent.progress = Math.min(0.99, iterations / maxIterations);
        store.saveAgent(agent);
        bus.emit(session.id, "agent.progress", { agentId: agent.id, progress: agent.progress, message: `iteration ${iterations}/${maxIterations}`, iteration: iterations, maxIterations });

        // 1. Build bounded context.
        const built = await buildContext({ workspace, history, toolResults, userRequest: iterations === 1 ? task : "Continue the task using the latest tool results. If the task is complete, reply with the final summary and NO tool calls.", budgetTokens: 48_000 });
        const modelMessages = [
          ...built.messages.map((m) => ({ role: m.role === "assistant" ? "assistant" as const : m.role, content: m.content, ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}), ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}) })),
          ...sessionMsgs,
        ];

        // 2. Call the model (streamed).
        bus.emit(session.id, "model.requested", { agentId: agent.id, provider: provider.name, model: agent.model });
        bus.emit(session.id, "model.started", { agentId: agent.id, provider: provider.name, model: agent.model });
        agent.metrics.modelCalls++;
        let streamed = "";
        let lastFlush = Date.now();
        const onStream = (e: StreamEvent): void => {
          if (e.kind === "text") {
            streamed += e.delta;
            const now = Date.now();
            if (now - lastFlush > 500 || e.delta.includes("\n")) {
              bus.emit(session.id, "model.stream", { agentId: agent.id, provider: provider.name, model: agent.model, chunk: streamed.slice(-4000) });
              lastFlush = now;
            }
          }
        };
        let resp: ModelResponse;
        try {
          resp = await provider.complete({ model: agent.model, system: built.system, messages: modelMessages.length ? modelMessages : [{ role: "user", content: task }], tools: this.opts.registry.functionSpecs(), signal }, onStream);
        } catch (e) {
          if (e instanceof ForgeError && e.code === "RateLimited") {
            log.warn("rate limited; single retry after 2s", { agentId: agent.id });
            await new Promise((r) => setTimeout(r, 2000));
            throwIfAborted(signal, "agent");
            resp = await provider.complete({ model: agent.model, system: built.system, messages: modelMessages.length ? modelMessages : [{ role: "user", content: task }], tools: this.opts.registry.functionSpecs(), signal }, onStream);
          } else throw e;
        }
        agent.metrics.inputTokens += resp.usage.inputTokens;
        agent.metrics.outputTokens += resp.usage.outputTokens;
        if (streamed && streamed !== resp.text) {
          bus.emit(session.id, "model.stream", { agentId: agent.id, provider: provider.name, model: agent.model, chunk: resp.text.slice(-4000) });
        }
        bus.emit(session.id, "model.completed", { agentId: agent.id, provider: provider.name, model: agent.model, finishReason: resp.finishReason, toolCalls: resp.toolCalls.map((t) => ({ id: t.id, tool: t.tool, input: t.input })), usage: resp.usage });

        // 3. Terminal answer?
        if (resp.toolCalls.length === 0) {
          finalText = resp.text.trim() || "(empty response)";
          const msgId = createMessageId();
          store.saveMessage({ id: msgId, sessionId: session.id, agentId: agent.id, role: "agent", content: finalText, createdAt: new Date().toISOString() });
          bus.emit(session.id, "message.agent", { messageId: msgId, agentId: agent.id, role: "agent", content: finalText });
          break;
        }

        // 4. Execute tool calls sequentially (deterministic, debuggable).
        sessionMsgs.push({ role: "assistant", content: resp.text, toolCalls: resp.toolCalls.map((t) => ({ id: t.id, tool: t.tool, input: t.input })) });
        for (const call of resp.toolCalls) {
          throwIfAborted(signal, `agent ${agent.id}`);
          setState("waiting_for_tool", call.tool);
          agent.metrics.toolCalls++;
          let output: string;
          try {
            const res = await this.opts.registry.execute(toolCtx, call.tool, call.input, signal);
            output = res.ok ? stringifyResult(res.result) : `ERROR: ${res.error}`;
          } catch (e) {
            if (e instanceof ForgeError && (e.code === "Cancelled" || e.code === "PermissionDenied" || e.code === "WorkspaceViolation")) throw e;
            output = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
          }
          const callId = createToolCallId();
          store.saveMessage({ id: createMessageId(), sessionId: session.id, agentId: agent.id, role: "tool", content: output.slice(0, 20000), toolCallId: callId, createdAt: new Date().toISOString() });
          const entry = { toolCallId: callId, tool: call.tool, output: output.slice(0, 20000) };
          toolResults.push(entry);
          sessionMsgs.push({ role: "tool", content: `Result of ${call.tool}:\n${output.slice(0, 20000)}`, toolCallId: call.id });
          if (agent.state === "waiting_for_tool") setState("executing", `${call.tool} done`);
        }
      }

      if (!finalText) {
        finalText = `Stopped after ${maxIterations} iterations without a final answer. Increase maxIterations to continue.`;
        const msgId = createMessageId();
        store.saveMessage({ id: msgId, sessionId: session.id, agentId: agent.id, role: "agent", content: finalText, createdAt: new Date().toISOString() });
        bus.emit(session.id, "message.agent", { messageId: msgId, agentId: agent.id, role: "agent", content: finalText });
      }

      agent.progress = 1;
      store.saveAgent(agent);
      store.saveTask({ id: taskId, sessionId: session.id, agentId: agent.id, title: task.slice(0, 500), status: "done", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      setState("completed", "final answer produced");
      bus.emit(session.id, "agent.completed", { agentId: agent.id, summary: finalText.slice(0, 2000), iterations });
      log.info(`agent ${agent.id} completed in ${iterations} iterations`, { sessionId: session.id, agentId: agent.id });
      return finalText;
    } catch (e) {
      const err = ForgeError.fromUnknown(e);
      agent.lastError = err.message;
      agent.updatedAt = new Date().toISOString();
      store.saveAgent(agent);
      store.saveTask({ id: taskId, sessionId: session.id, agentId: agent.id, title: task.slice(0, 500), status: err.code === "Cancelled" ? "cancelled" : "failed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (err.code === "Cancelled") {
        if (!isTerminal(agent.state)) {
          try {
            setState("cancelled", err.message);
          } catch {
            agent.state = "cancelled";
            store.saveAgent(agent);
          }
        }
        bus.emit(session.id, "agent.cancelled", { agentId: agent.id, reason: err.message });
      } else {
        bus.emit(session.id, "model.failed", { agentId: agent.id, provider: provider.name, model: agent.model, error: err.message });
        if (!isTerminal(agent.state)) {
          try {
            setState("failed", err.message);
          } catch {
            agent.state = "failed";
            store.saveAgent(agent);
          }
        }
        bus.emit(session.id, "agent.failed", { agentId: agent.id, error: err.message, iterations: 0 });
      }
      throw err;
    } finally {
      this.running.delete(agentId);
    }
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}
