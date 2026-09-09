import {
  createAgentId,
  type Agent,
  type AgentId,
  type AgentMetrics,
  type AgentPermissions,
  type AgentState,
  type SessionId,
  type TaskId,
  type WorkspaceId,
} from "@forge/protocol";
import { ForgeError } from "@forge/protocol";

/** Explicit transition table. Anything not listed fails safely. */
const TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  created: ["idle", "cancelled"],
  idle: ["planning", "cancelled"],
  planning: ["executing", "failed", "cancelled"],
  executing: ["waiting_for_tool", "reviewing", "paused", "completed", "failed", "cancelled"],
  waiting_for_tool: ["executing", "paused", "failed", "cancelled"],
  paused: ["executing", "cancelled"],
  reviewing: ["executing", "completed", "failed", "cancelled"],
  failed: ["idle", "cancelled"], // failed -> idle allows retry
  completed: [],
  cancelled: [],
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Mutates + returns the agent. Throws InvalidRequest on illegal transitions. */
export function transition(agent: Agent, to: AgentState, reason?: string): { from: AgentState; to: AgentState } {
  if (!canTransition(agent.state, to)) {
    throw new ForgeError("InvalidRequest", `illegal agent transition ${agent.state} -> ${to}${reason ? `: ${reason}` : ""}`);
  }
  const from = agent.state;
  agent.state = to;
  agent.updatedAt = new Date().toISOString();
  return { from, to };
}

export function isTerminal(state: AgentState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

export function emptyMetrics(): AgentMetrics {
  return { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, filesRead: 0, filesWritten: 0, commandsRun: 0, testsRun: 0 };
}

export function createAgent(opts: {
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  name?: string;
  role?: string;
  provider: string;
  model: string;
  permissions: AgentPermissions;
  currentTask?: TaskId | null;
  id?: AgentId;
}): Agent {
  const now = new Date().toISOString();
  return {
    id: opts.id ?? createAgentId(),
    sessionId: opts.sessionId,
    name: opts.name ?? "forge-agent",
    role: opts.role ?? "coding-agent",
    model: opts.model,
    provider: opts.provider,
    state: "created",
    currentTask: opts.currentTask ?? null,
    workspaceId: opts.workspaceId,
    permissions: opts.permissions,
    createdAt: now,
    updatedAt: now,
    progress: 0,
    metrics: emptyMetrics(),
  };
}
