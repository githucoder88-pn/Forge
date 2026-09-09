/**
 * Strongly-typed identifiers. Core never passes raw strings for domain identity.
 * IDs are prefixed (`agent_…`, `task_…`) so they are recognizable in logs/events.
 */

export type Brand<Kind extends string, T> = T & { readonly __brand: Kind };

export type AgentId = Brand<'AgentId', string>;
export type SessionId = Brand<'SessionId', string>;
export type TaskId = Brand<'TaskId', string>;
export type TeamId = Brand<'TeamId', string>;
export type MessageId = Brand<'MessageId', string>;
export type ToolCallId = Brand<'ToolCallId', string>;
export type WorkspaceId = Brand<'WorkspaceId', string>;
export type ModelId = Brand<'ModelId', string>;
export type ProviderId = Brand<'ProviderId', string>;
export type CheckpointId = Brand<'CheckpointId', string>;
export type EventId = Brand<'EventId', string>;
export type ApprovalId = Brand<'ApprovalId', string>;
export type MemoryId = Brand<'MemoryId', string>;

function gen(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  const extra = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${time}${rand}${extra}`;
}

export const agentId = (): AgentId => gen('agent') as AgentId;
export const sessionId = (): SessionId => gen('sess') as SessionId;
export const taskId = (): TaskId => gen('task') as TaskId;
export const teamId = (): TeamId => gen('team') as TeamId;
export const messageId = (): MessageId => gen('msg') as MessageId;
export const toolCallId = (): ToolCallId => gen('tool') as ToolCallId;
export const workspaceId = (): WorkspaceId => gen('ws') as WorkspaceId;
export const modelId = (raw: string): ModelId => raw as ModelId;
export const providerId = (raw: string): ProviderId => raw as ProviderId;
export const checkpointId = (): CheckpointId => gen('ckpt') as CheckpointId;
export const eventId = (): EventId => gen('evt') as EventId;
export const approvalId = (): ApprovalId => gen('appr') as ApprovalId;
export const memoryId = (): MemoryId => gen('mem') as MemoryId;

const PREFIX: Record<string, string> = {
  agent: 'agent', sess: 'sess', task: 'task', team: 'team', msg: 'msg',
  tool: 'tool', ws: 'ws', ckpt: 'ckpt', evt: 'evt', appr: 'appr', mem: 'mem',
};

export function idKind(id: string): string | undefined {
  const p = id.split('_')[0] ?? '';
  return PREFIX[p];
}

/** Current time as ISO string (single helper so timestamps are consistent). */
export const nowIso = (): string => new Date().toISOString();
