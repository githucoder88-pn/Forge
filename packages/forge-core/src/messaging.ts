/**
 * Agent messaging: real persisted messages (not UI decoration). Agents
 * report blockers, ask questions and hand off work through here; the
 * communication view renders this exact stream.
 */
import { MessageId, SessionId, TaskId, TeamId, messageId, nowIso } from './ids.js';
import { EventBus } from './events.js';
import type { SqliteStore } from './store.js';

export type AgentMessageType =
  | 'request' | 'response' | 'question' | 'answer' | 'status'
  | 'handoff' | 'warning' | 'blocked' | 'approval' | 'broadcast';

export interface AgentMessage {
  id: MessageId;
  sessionId?: SessionId;
  teamId?: TeamId;
  taskId?: TaskId;
  from: string;
  /** Agent id/name, or '*' for broadcast. */
  to: string;
  type: AgentMessageType;
  subject?: string;
  body: string;
  ts: string;
}

export class MessageBus {
  constructor(private store: SqliteStore, private bus?: EventBus) {}

  send(input: { sessionId?: SessionId; teamId?: TeamId; taskId?: TaskId; from: string; to: string; type: AgentMessageType; subject?: string; body: string }): AgentMessage {
    const msg: AgentMessage = {
      id: messageId(),
      sessionId: input.sessionId,
      teamId: input.teamId,
      taskId: input.taskId,
      from: input.from,
      to: input.to,
      type: input.type,
      subject: input.subject,
      body: input.body,
      ts: nowIso(),
    };
    this.store.saveMessage({
      id: msg.id, sessionId: msg.sessionId, teamId: msg.teamId, taskId: msg.taskId,
      from: msg.from, to: msg.to, type: msg.type, ts: msg.ts, body: msg,
    });
    this.bus?.emit({
      type: 'agent.message.sent', sessionId: msg.sessionId, taskId: msg.taskId, teamId: msg.teamId,
      data: { ...msg },
    });
    return msg;
  }

  /** Inbox for one agent: direct messages + broadcasts, oldest first. */
  inbox(sessionId: string | undefined, agentRef: string, limit = 200): AgentMessage[] {
    const rows = this.store.loadMessages({ sessionId, to: agentRef, limit });
    return rows.map((r) => r.data as AgentMessage);
  }

  /** Full conversation for a session or team (for the communication view). */
  conversation(opts: { sessionId?: string; teamId?: string; taskId?: string; limit?: number }): AgentMessage[] {
    const rows = this.store.loadMessages({ sessionId: opts.sessionId, limit: opts.limit ?? 500 });
    let msgs = rows.map((r) => r.data as AgentMessage);
    if (opts.teamId) msgs = msgs.filter((m) => m.teamId === opts.teamId || m.to === '*');
    if (opts.taskId) msgs = msgs.filter((m) => m.taskId === opts.taskId);
    return msgs;
  }
}
