import type { AgentId, EventId, SessionId, ToolCallId } from "./ids.ts";
import type { AgentState } from "./types.ts";

export const PROTOCOL_VERSION = "1.0" as const;

export const EVENT_TYPES = [
  "session.created",
  "session.resumed",
  "agent.created",
  "agent.started",
  "agent.state_changed",
  "agent.progress",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  "message.user",
  "message.agent",
  "tool.started",
  "tool.output",
  "tool.completed",
  "tool.failed",
  "file.created",
  "file.modified",
  "file.deleted",
  "model.requested",
  "model.started",
  "model.stream",
  "model.completed",
  "model.failed",
  "command.started",
  "command.output",
  "command.completed",
  "command.failed",
  "test.started",
  "test.passed",
  "test.failed",
  "approval.requested",
  "approval.resolved",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventEnvelope<T extends EventType = EventType, P = unknown> {
  /** Unique event identity. */
  id: EventId;
  /** Monotonic per-session sequence number — the ordering key (NOT timestamp). */
  seq: number;
  /** Wall-clock time the event was recorded (ISO-8601). */
  ts: string;
  protocol: typeof PROTOCOL_VERSION;
  sessionId: SessionId;
  type: T;
  payload: P;
  /** Optional causal parent (e.g. tool.output -> tool.started). */
  causationId?: EventId;
}

export interface AgentStateChangedPayload {
  agentId: AgentId;
  from: AgentState;
  to: AgentState;
  reason?: string;
}

export interface AgentProgressPayload {
  agentId: AgentId;
  /** 0..1 best-effort progress estimate (iterations consumed / budget). */
  progress: number;
  message: string;
  iteration?: number;
  maxIterations?: number;
}

export interface ToolEventPayload {
  toolCallId: ToolCallId;
  agentId?: AgentId;
  tool: string;
  /** Truncated preview; full output lives in tool.completed payload / store. */
  chunk?: string;
  ok?: boolean;
  durationMs?: number;
  error?: string;
  result?: unknown;
}

export interface MessagePayload {
  messageId: string;
  agentId?: AgentId;
  role: "user" | "agent" | "system" | "tool";
  content: string;
  toolCalls?: { id: ToolCallId; tool: string; input: unknown }[];
}

export interface FileEventPayload {
  path: string;
  agentId?: AgentId;
  bytes?: number;
  diffPreview?: string;
}

export interface ModelEventPayload {
  agentId?: AgentId;
  provider: string;
  model: string;
  chunk?: string;
  toolCalls?: { id: string; tool: string; input: unknown }[];
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
}

export interface CommandEventPayload extends ToolEventPayload {
  command: string;
  cwd: string;
  exitCode?: number;
}

export interface TestEventPayload {
  agentId?: AgentId;
  command: string;
  passed?: boolean;
  exitCode?: number;
  summary?: string;
  durationMs?: number;
}

export type EventPayloadMap = {
  "session.created": { sessionId: SessionId; workspaceRoot: string };
  "session.resumed": { sessionId: SessionId; seq: number };
  "agent.created": { agentId: AgentId; name: string; task: string };
  "agent.started": { agentId: AgentId; task: string };
  "agent.state_changed": AgentStateChangedPayload;
  "agent.progress": AgentProgressPayload;
  "agent.completed": { agentId: AgentId; summary: string; iterations: number };
  "agent.failed": { agentId: AgentId; error: string; iterations: number };
  "agent.cancelled": { agentId: AgentId; reason: string };
  "message.user": MessagePayload;
  "message.agent": MessagePayload;
  "tool.started": ToolEventPayload;
  "tool.output": ToolEventPayload;
  "tool.completed": ToolEventPayload;
  "tool.failed": ToolEventPayload;
  "file.created": FileEventPayload;
  "file.modified": FileEventPayload;
  "file.deleted": FileEventPayload;
  "model.requested": ModelEventPayload;
  "model.started": ModelEventPayload;
  "model.stream": ModelEventPayload;
  "model.completed": ModelEventPayload;
  "model.failed": ModelEventPayload;
  "command.started": CommandEventPayload;
  "command.output": CommandEventPayload;
  "command.completed": CommandEventPayload;
  "command.failed": CommandEventPayload;
  "test.started": TestEventPayload;
  "test.passed": TestEventPayload;
  "test.failed": TestEventPayload;
  "approval.requested": { approvalId: string; tool: string; reason: string; input: unknown };
  "approval.resolved": { approvalId: string; approved: boolean; by?: string };
};

export function isEventType(t: string): t is EventType {
  return (EVENT_TYPES as readonly string[]).includes(t);
}
