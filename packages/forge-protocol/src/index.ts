/**
 * @forge/protocol — the versioned Forge wire protocol.
 *
 * Transport: JSON-RPC 2.0 over HTTP POST /rpc (+ optional batch), live
 * events over WebSocket /ws and SSE GET /events. All clients (CLI, Web,
 * Electron, Tauri, future IDE integrations) speak exactly this protocol;
 * no client may bypass it with private endpoints.
 */

export const PROTOCOL_VERSION = 'forge/1';

/** Every RPC method Core exposes. Clients must not invent others. */
export const FORGE_METHODS = [
  'session.create', 'session.resume', 'session.list', 'session.get', 'session.close',
  'agent.create', 'agent.list', 'agent.get', 'agent.start', 'agent.pause', 'agent.resume',
  'agent.cancel', 'agent.retry', 'agent.spawn', 'agent.handoff', 'agent.setTask',
  'task.create', 'task.list', 'task.get', 'task.update', 'task.cancel', 'task.pause',
  'task.resume', 'task.retry', 'task.setOwner', 'task.topo', 'task.run',
  'team.create', 'team.list', 'team.get', 'team.addMember', 'team.removeMember',
  'team.setRole', 'team.setManager', 'team.enqueueTask', 'team.status',
  'message.send', 'message.inbox', 'message.conversation',
  'tool.list', 'tool.invoke',
  'workspace.read', 'workspace.write', 'workspace.list', 'workspace.search',
  'workspace.symbols', 'workspace.instructions', 'workspace.history',
  'model.status', 'model.refresh', 'model.route',
  'checkpoint.create', 'checkpoint.list', 'checkpoint.restore', 'checkpoint.rollback',
  'approval.list', 'approval.resolve',
  'memory.put', 'memory.get', 'memory.list', 'memory.search', 'memory.delete',
  'context.build',
  'events.replay',
  'runtime.run', 'runtime.plan', 'runtime.enhance', 'runtime.review', 'runtime.status',
  'config.get',
  'demo.run',
] as const;

export type ForgeMethod = (typeof FORGE_METHODS)[number];

// ------------------------------------------------------------ envelopes ---

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** Server → client event notification (WS) / SSE payload. */
export interface EventNotification {
  jsonrpc: '2.0';
  method: 'event';
  params: {
    id: string;
    seq: number;
    v: 1;
    ts: string;
    type: string;
    sessionId?: string;
    agentId?: string;
    taskId?: string;
    teamId?: string;
    simulated?: boolean;
    data: unknown;
  };
}

export const RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  FORGE: -32000,
} as const;

export function success(id: number | string, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function failure(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

// ------------------------------------------------------------------ DTOs ---

/** DTOs mirror Core shapes structurally so browser clients stay dependency-free. */

export interface SessionDTO {
  id: string; name: string; projectDir: string; status: string;
  createdAt: string; updatedAt: string;
  agentIds: string[]; taskIds: string[]; teamIds: string[];
  lastEventSeq: number; simulated?: boolean;
}

export interface AgentDTO {
  id: string; sessionId: string; name: string; role: string;
  capabilities: string[]; model?: { provider: string; model: string };
  autonomy: string; policy: string; state: string;
  progress: number | null; currentTaskId?: string; currentAction?: string;
  parentAgentId?: string; teamId?: string; children: string[];
  plan: { title: string; done: boolean }[];
  metrics: Record<string, unknown>;
  createdAt: string; updatedAt: string; lastError?: string;
  simulated?: boolean;
}

export interface TaskDTO {
  id: string; sessionId: string; title: string; description: string;
  status: string; priority: number; dependsOn: string[];
  ownerAgentId?: string; teamId?: string;
  progress: number | null; artifacts: string[];
  errors: { message: string; code?: string; at: string }[];
  retries: number; maxRetries: number;
  createdAt: string; updatedAt: string;
  startedAt?: string; completedAt?: string; blockedBy?: string;
}

export interface TeamDTO {
  id: string; sessionId: string; name: string;
  managerAgentId?: string; memberIds: string[];
  roles: Record<string, string>; sharedGoal?: string;
  sharedContext: string[]; taskQueue: string[];
  createdAt: string; updatedAt: string;
}

export interface MessageDTO {
  id: string; sessionId?: string; teamId?: string; taskId?: string;
  from: string; to: string; type: string; subject?: string; body: string; ts: string;
}

export interface CheckpointDTO {
  id: string; sessionId: string; label: string; createdAt: string;
  gitHead?: string; gitDirty?: boolean; eventSeq: number;
}

export interface ApprovalDTO {
  id: string; agentId?: string; kind: string; summary: string;
  detail?: Record<string, unknown>; risk: string;
  requestedAt: string; status: string; resolvedAt?: string;
}

// ------------------------------------------------------------- validation ---

export class ProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.data = data;
  }
}

export function paramsObject(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new ProtocolError(RPC_ERROR.INVALID_PARAMS, 'params must be an object');
  }
  return params as Record<string, unknown>;
}

export function reqString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v.length === 0) throw new ProtocolError(RPC_ERROR.INVALID_PARAMS, `params.${key} must be a non-empty string`);
  return v;
}

export function optString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ProtocolError(RPC_ERROR.INVALID_PARAMS, `params.${key} must be a string`);
  return v;
}

export function optNumber(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number') throw new ProtocolError(RPC_ERROR.INVALID_PARAMS, `params.${key} must be a number`);
  return v;
}

export function optBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const v = params[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ProtocolError(RPC_ERROR.INVALID_PARAMS, `params.${key} must be a boolean`);
  return v;
}

export function optStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const v = params[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new ProtocolError(RPC_ERROR.INVALID_PARAMS, `params.${key} must be a string array`);
  }
  return v as string[];
}

export function isForgeMethod(m: string): m is ForgeMethod {
  return (FORGE_METHODS as readonly string[]).includes(m);
}
