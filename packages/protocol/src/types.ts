import type {
  AgentId,
  CheckpointId,
  MemoryId,
  MessageId,
  ModelId,
  ProviderId,
  SessionId,
  TaskId,
  ToolCallId,
  WorkspaceId,
} from "./ids.ts";

/** Agent lifecycle states. Transitions are validated by the Core state machine. */
export const AGENT_STATES = [
  "created",
  "idle",
  "planning",
  "executing",
  "waiting_for_tool",
  "paused",
  "failed",
  "completed",
  "cancelled",
  "reviewing",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export type PermissionMode = "read-only" | "workspace-write" | "full-workspace";
export type ApprovalPolicy = "always" | "risky-only" | "never";

export interface AgentPermissions {
  mode: PermissionMode;
  approval: ApprovalPolicy;
  /** Extra allowed commands beyond the safe default set (exact binary names). */
  allowCommands?: string[];
  /** Denied binary names — always rejected. */
  denyCommands?: string[];
}

export interface AgentMetrics {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  filesRead: number;
  filesWritten: number;
  commandsRun: number;
  testsRun: number;
}

export interface Agent {
  id: AgentId;
  sessionId: SessionId;
  name: string;
  role: string;
  model: string;
  provider: string;
  state: AgentState;
  currentTask: TaskId | null;
  workspaceId: WorkspaceId;
  permissions: AgentPermissions;
  createdAt: string;
  updatedAt: string;
  /** 0..1 best-effort progress. */
  progress: number;
  metrics: AgentMetrics;
  lastError?: string;
  // Future extension points (Phase 2+): parent/children/team/memory live here.
  parentAgent?: AgentId | null;
  teamId?: string | null;
  memoryIds?: MemoryId[];
}

export interface Task {
  id: TaskId;
  sessionId: SessionId;
  agentId: AgentId | null;
  title: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  agentId: AgentId | null;
  role: "user" | "agent" | "system" | "tool";
  content: string;
  toolCallId?: ToolCallId | null;
  createdAt: string;
}

export interface SessionConfig {
  provider: string;
  model: string;
  permissions: AgentPermissions;
  maxIterations: number;
}

export interface Session {
  id: SessionId;
  workspaceId: WorkspaceId;
  workspaceRoot: string;
  title: string;
  config: SessionConfig;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  activeAgentId: AgentId | null;
  checkpointId?: CheckpointId | null;
}

export interface WorkspaceInfo {
  id: WorkspaceId;
  root: string;
  createdAt: string;
}

export interface ModelRef {
  provider: ProviderId;
  model: ModelId;
  name: string;
}

export interface ResourceLimits {
  maxConcurrentTools: number;
  maxShellProcesses: number;
  maxOutputBytes: number;
  maxModelRequestBytes: number;
  maxAgentRuntimeMs: number;
  commandTimeoutMs: number;
  maxIterations: number;
  maxFileBytes: number;
  maxSearchResults: number;
}

export interface SessionSnapshot {
  session: Session;
  agents: Agent[];
  messages: Message[];
  tasks: Task[];
  lastSeq: number;
}
