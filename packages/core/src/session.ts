import {
  createSessionId,
  createWorkspaceId,
  ForgeError,
  type Agent,
  type AgentId,
  type AgentPermissions,
  type Session,
  type SessionConfig,
  type SessionId,
  type SessionSnapshot,
} from "@forge/protocol";
import type { ForgeConfig } from "./config.ts";
import { createAgent } from "./agent.ts";
import type { AgentRuntime } from "./agentLoop.ts";
import type { EventBus } from "./eventBus.ts";
import type { Logger } from "./logger.ts";
import type { Store } from "./store.ts";
import type { ToolContext } from "./toolRegistry.ts";
import { Workspace } from "./workspace.ts";

export interface CreateSessionOpts {
  workspaceRoot: string;
  title?: string;
  provider?: string;
  model?: string;
  permissions?: Partial<AgentPermissions>;
  maxIterations?: number;
}

/** Session runtime — owns sessions, agents, snapshots. Survives client restarts. */
export class SessionManager {
  private store: Store;
  private bus: EventBus;
  private runtime: AgentRuntime;
  private config: ForgeConfig;
  private log: Logger;
  constructor(store: Store, bus: EventBus, runtime: AgentRuntime, config: ForgeConfig, log: Logger) {
    this.store = store;
    this.bus = bus;
    this.runtime = runtime;
    this.config = config;
    this.log = log;
  }

  createSession(opts: CreateSessionOpts): Session {
    const workspace = new Workspace(opts.workspaceRoot); // validates existence (NotFound otherwise)
    const now = new Date().toISOString();
    const cfg: SessionConfig = {
      provider: opts.provider ?? this.config.provider,
      model: opts.model ?? this.config.model,
      permissions: {
        mode: opts.permissions?.mode ?? "workspace-write",
        approval: opts.permissions?.approval ?? "risky-only",
      },
      maxIterations: opts.maxIterations ?? this.config.limits.maxIterations,
    };
    const session: Session = {
      id: createSessionId(),
      workspaceId: createWorkspaceId(),
      workspaceRoot: workspace.root,
      title: opts.title ?? `Session ${new Date().toLocaleString()}`,
      config: cfg,
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      activeAgentId: null,
    };
    this.store.saveSession(session);
    this.bus.emit(session.id, "session.created", { sessionId: session.id, workspaceRoot: session.workspaceRoot });
    this.log.info(`session created: ${session.id}`, { sessionId: session.id });
    return session;
  }

  getSession(id: SessionId): Session {
    const s = this.store.getSession(id);
    if (!s) throw new ForgeError("NotFound", `session not found: ${id}`);
    return s;
  }

  listSessions(limit = 50, offset = 0): Session[] {
    return this.store.listSessions(limit, offset);
  }

  resumeSession(id: SessionId): SessionSnapshot {
    const session = this.getSession(id);
    session.updatedAt = new Date().toISOString();
    this.store.saveSession(session);
    this.bus.emit(session.id, "session.resumed", { sessionId: id, seq: session.lastSeq });
    return this.snapshot(id);
  }

  snapshot(id: SessionId): SessionSnapshot {
    const session = this.getSession(id);
    return {
      session,
      agents: this.store.listAgents(id),
      messages: this.store.listMessages(id),
      tasks: this.store.listTasks(id),
      lastSeq: session.lastSeq,
    };
  }

  getAgent(agentId: AgentId): Agent {
    const a = this.store.getAgent(agentId);
    if (!a) throw new ForgeError("NotFound", `agent not found: ${agentId}`);
    return a;
  }

  /** Ensure a usable agent for the session (reuse active when idle, else create). */
  ensureAgent(session: Session, agentId?: AgentId): Agent {
    if (agentId) {
      const a = this.getAgent(agentId);
      if (a.sessionId !== session.id) throw new ForgeError("InvalidRequest", "agent belongs to another session");
      if (a.state === "completed" || a.state === "failed" || a.state === "cancelled") {
        return this.spawnAgent(session);
      }
      return a;
    }
    if (session.activeAgentId) {
      const active = this.store.getAgent(session.activeAgentId);
      if (active && (active.state === "idle" || active.state === "created")) return active;
      if (active && !this.runtime.isRunning(active.id) && (active.state === "completed" || active.state === "failed" || active.state === "cancelled")) {
        return this.spawnAgent(session);
      }
      if (active && this.runtime.isRunning(active.id)) {
        throw new ForgeError("Conflict", "session agent is already running; wait or cancel it first");
      }
    }
    return this.spawnAgent(session);
  }

  private spawnAgent(session: Session): Agent {
    const agent = createAgent({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      provider: session.config.provider,
      model: session.config.model,
      permissions: session.config.permissions,
    });
    this.store.saveAgent(agent);
    session.activeAgentId = agent.id;
    session.updatedAt = new Date().toISOString();
    this.store.saveSession(session);
    this.bus.emit(session.id, "agent.created", { agentId: agent.id, name: agent.name, task: "" });
    return agent;
  }

  /**
   * Queue a user message and launch the agent loop in the background.
   * Returns immediately — clients follow progress via the event stream.
   */
  sendMessage(sessionId: SessionId, content: string, agentId?: AgentId): { agentId: AgentId; accepted: boolean } {
    const session = this.getSession(sessionId);
    const agent = this.ensureAgent(session, agentId as AgentId | undefined);
    // Fire-and-forget: the loop reports via events + persisted state.
    void this.runtime.run(agent.id, content).catch((e: unknown) => {
      this.log.warn(`agent run ended: ${(e as Error).message}`, { sessionId, agentId: agent.id });
    });
    return { agentId: agent.id, accepted: true };
  }

  cancelAgent(agentId: AgentId, reason?: string): { cancelled: boolean } {
    this.getAgent(agentId); // NotFound when unknown
    return { cancelled: this.runtime.cancel(agentId, reason) };
  }

  /** Tool context for direct (non-agent) RPC tool calls, attributed to the active agent when present. */
  toolContextFor(sessionId: SessionId): ToolContext {
    const session = this.getSession(sessionId);
    let agent: Agent | null = session.activeAgentId ? this.store.getAgent(session.activeAgentId) : null;
    if (!agent) {
      agent = createAgent({
        sessionId: session.id, workspaceId: session.workspaceId,
        name: "rpc", role: "direct-tool-call",
        provider: session.config.provider, model: session.config.model,
        permissions: session.config.permissions,
      });
      agent.state = "executing"; // ephemeral, never persisted
    }
    return this.runtime.buildToolContext(session, agent, new Workspace(session.workspaceRoot));
  }
}
