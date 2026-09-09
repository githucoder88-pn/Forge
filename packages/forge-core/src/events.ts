/**
 * Typed event bus. Every major state transition in Core emits a structured,
 * timestamped, ordered event. Clients (CLI/Web/Electron/Tauri) consume the
 * same stream — the UI never invents state.
 */
import { AgentId, EventId, SessionId, TaskId, TeamId, eventId, nowIso } from './ids.js';

export type EventType =
  | 'session.created' | 'session.resumed' | 'session.closed'
  | 'agent.created' | 'agent.started' | 'agent.progress' | 'agent.waiting'
  | 'agent.blocked' | 'agent.paused' | 'agent.resumed' | 'agent.completed'
  | 'agent.failed' | 'agent.cancelled' | 'agent.action'
  | 'agent.message.sent' | 'agent.message.received'
  | 'task.created' | 'task.started' | 'task.updated' | 'task.completed'
  | 'task.failed' | 'task.blocked' | 'task.cancelled' | 'task.retried'
  | 'team.created' | 'team.updated'
  | 'tool.started' | 'tool.output' | 'tool.completed' | 'tool.failed'
  | 'file.created' | 'file.modified' | 'file.deleted'
  | 'model.requested' | 'model.started' | 'model.stream' | 'model.completed'
  | 'model.failed' | 'model.fallback' | 'model.routed'
  | 'git.changed' | 'test.started' | 'test.passed' | 'test.failed'
  | 'checkpoint.created' | 'checkpoint.restored'
  | 'approval.requested' | 'approval.resolved'
  | 'context.compacted' | 'plan.created' | 'review.decision'
  | 'runtime.warning' | 'runtime.error';

export interface ForgeEvent<T = unknown> {
  id: EventId;
  /** Monotonic per-bus sequence number. Ordered + replayable. */
  seq: number;
  /** Protocol/event-schema version. */
  v: 1;
  ts: string;
  type: EventType;
  sessionId?: SessionId;
  agentId?: AgentId;
  taskId?: TaskId;
  teamId?: TeamId;
  /** True only for demo/test fallback traffic. Must be rendered as SIMULATED. */
  simulated?: boolean;
  data: T;
}

export type EventFilter =
  | { types?: EventType[]; sessionId?: SessionId; agentId?: AgentId; taskId?: TaskId; teamId?: TeamId; sinceSeq?: number }
  | ((e: ForgeEvent) => boolean);

export type EventHandler = (e: ForgeEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface EmitInput<T = unknown> {
  type: EventType;
  sessionId?: SessionId;
  agentId?: AgentId;
  taskId?: TaskId;
  teamId?: TeamId;
  simulated?: boolean;
  data: T;
}

const DEFAULT_RING = 5000;

export class EventBus {
  private seq = 0;
  private ring: ForgeEvent[] = [];
  private readonly cap: number;
  private subs = new Map<number, { filter: EventFilter; handler: EventHandler }>();
  private nextSub = 1;
  private persistHook?: (e: ForgeEvent) => void;
  private closed = false;

  constructor(opts?: { ringCapacity?: number; persist?: (e: ForgeEvent) => void }) {
    this.cap = Math.max(100, opts?.ringCapacity ?? DEFAULT_RING);
    this.persistHook = opts?.persist;
  }

  setPersistHook(fn: (e: ForgeEvent) => void): void {
    this.persistHook = fn;
  }

  emit<T>(input: EmitInput<T>): ForgeEvent<T> {
    if (this.closed) throw new Error('EventBus is closed');
    const e: ForgeEvent<T> = {
      id: eventId(),
      seq: ++this.seq,
      v: 1,
      ts: nowIso(),
      type: input.type,
      sessionId: input.sessionId,
      agentId: input.agentId,
      taskId: input.taskId,
      teamId: input.teamId,
      simulated: input.simulated || undefined,
      data: input.data,
    };
    this.ring.push(e as ForgeEvent);
    if (this.ring.length > this.cap) this.ring.splice(0, this.ring.length - this.cap);
    if (this.persistHook) {
      try { this.persistHook(e as ForgeEvent); } catch { /* persistence must not break the bus */ }
    }
    for (const { filter, handler } of this.subs.values()) {
      if (matches(filter, e as ForgeEvent)) {
        try {
          const r = handler(e as ForgeEvent);
          if (r instanceof Promise) r.catch(() => undefined);
        } catch { /* a failing subscriber must not break others */ }
      }
    }
    return e;
  }

  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe {
    const id = this.nextSub++;
    this.subs.set(id, { filter, handler });
    return () => { this.subs.delete(id); };
  }

  /** Replay buffered events matching filter with seq > sinceSeq (ordered). */
  replay(sinceSeq = 0, filter?: EventFilter, limit = 1000): ForgeEvent[] {
    const out: ForgeEvent[] = [];
    for (const e of this.ring) {
      if (e.seq <= sinceSeq) continue;
      if (filter && !matches(filter, e)) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  history(filter?: EventFilter, limit = 200): ForgeEvent[] {
    const out: ForgeEvent[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.ring[i] as ForgeEvent;
      if (filter && !matches(filter, e)) continue;
      out.push(e);
    }
    return out.reverse();
  }

  latestSeq(): number { return this.seq; }
  subscriberCount(): number { return this.subs.size; }

  /** Seed the sequence counter (used on boot to continue persisted history). */
  setMinimumSeq(n: number): void {
    if (n > this.seq) this.seq = n;
  }

  close(): void {
    this.closed = true;
    this.subs.clear();
  }
}

export function matches(filter: EventFilter, e: ForgeEvent): boolean {
  if (typeof filter === 'function') return filter(e);
  if (filter.types && !filter.types.includes(e.type)) return false;
  if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
  if (filter.agentId && e.agentId !== filter.agentId) return false;
  if (filter.taskId && e.taskId !== filter.taskId) return false;
  if (filter.teamId && e.teamId !== filter.teamId) return false;
  if (filter.sinceSeq !== undefined && e.seq <= filter.sinceSeq) return false;
  return true;
}
