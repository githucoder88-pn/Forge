import {
  createEventId,
  PROTOCOL_VERSION,
  type EventEnvelope,
  type EventId,
  type EventPayloadMap,
  type EventType,
  type SessionId,
} from "@forge/protocol";
import type { Store } from "./store.ts";
import type { Logger } from "./logger.ts";

export type EventHandler = (e: EventEnvelope) => void;

/**
 * Phase-1 event bus: synchronous in-memory fan-out + durable SQLite append.
 * Ordering key is the per-session `seq` (allocated by the store); `ts` is informational.
 */
export class EventBus {
  private subs = new Map<string, Set<EventHandler>>(); // sessionId -> handlers; "*" = all sessions

  private store: Store;
  private log: Logger;
  constructor(store: Store, log: Logger) {
    this.store = store;
    this.log = log;
  }

  emit<T extends EventType>(sessionId: SessionId, type: T, payload: EventPayloadMap[T], causationId?: EventId): EventEnvelope<T, EventPayloadMap[T]> {
    const stored = this.store.appendEvent({
      id: createEventId(),
      ts: new Date().toISOString(),
      protocol: PROTOCOL_VERSION,
      sessionId,
      type,
      payload,
      ...(causationId ? { causationId } : {}),
    });
    const env = stored as EventEnvelope<T, EventPayloadMap[T]>;
    this.log.debug(`event ${type} seq=${env.seq}`, { sessionId, eventId: env.id });
    for (const key of [sessionId, "*"]) {
      const set = this.subs.get(key);
      if (!set) continue;
      for (const h of [...set]) {
        try {
          h(env as EventEnvelope);
        } catch (e) {
          this.log.error(`event handler threw: ${(e as Error).message}`, { sessionId });
        }
      }
    }
    return env;
  }

  /** Subscribe to live events. Set `replayAfterSeq` to first receive persisted catch-up. */
  subscribe(sessionId: SessionId | "*", handler: EventHandler, replayAfterSeq?: number): () => void {
    const key = sessionId;
    let set = this.subs.get(key);
    if (!set) {
      set = new Set();
      this.subs.set(key, set);
    }
    set.add(handler);
    if (replayAfterSeq !== undefined && sessionId !== "*") {
      const missed = this.store.listEvents(sessionId, replayAfterSeq);
      for (const e of missed) {
        try {
          handler(e);
        } catch {
          /* handler errors are reported on live path; ignore in replay */
        }
      }
    }
    return () => {
      set.delete(handler);
      if (set.size === 0) this.subs.delete(key);
    };
  }
}
