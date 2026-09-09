/**
 * Sessions: the unit of resumability. A closed client never destroys the
 * runtime session — all state persists in the store for `session resume`.
 */
import { AgentId, SessionId, TaskId, TeamId, nowIso, sessionId } from './ids.js';
import { ForgeError } from './errors.js';
import { EventBus } from './events.js';
import type { ForgeConfig } from './config.js';
import type { SqliteStore } from './store.js';

export type SessionStatus = 'active' | 'paused' | 'closed';

export interface Session {
  id: SessionId;
  name: string;
  projectDir: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  configOverrides?: Partial<ForgeConfig>;
  agentIds: AgentId[];
  taskIds: TaskId[];
  teamIds: TeamId[];
  lastEventSeq: number;
  /** True for demo sessions. Clients must render these as DEMO / SIMULATED. */
  simulated?: boolean;
}

const KIND = 'session';

export class SessionManager {
  constructor(private store: SqliteStore, private bus?: EventBus) {}

  create(input: { name?: string; projectDir: string; configOverrides?: Partial<ForgeConfig>; simulated?: boolean }): Session {
    const now = nowIso();
    const sess: Session = {
      id: sessionId(),
      name: input.name ?? `session-${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      projectDir: input.projectDir,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      configOverrides: input.configOverrides,
      agentIds: [],
      taskIds: [],
      teamIds: [],
      lastEventSeq: 0,
      simulated: input.simulated || undefined,
    };
    this.save(sess);
    this.bus?.emit({ type: 'session.created', sessionId: sess.id, data: { name: sess.name, projectDir: sess.projectDir } });
    return sess;
  }

  resume(id: string): Session {
    const sess = this.get(id);
    if (sess.status === 'closed') {
      sess.status = 'active';
      sess.updatedAt = nowIso();
      this.save(sess);
    }
    this.bus?.emit({ type: 'session.resumed', sessionId: sess.id, data: { name: sess.name } });
    return sess;
  }

  get(id: string): Session {
    const sess = this.store.getDoc<Session>(KIND, id);
    if (!sess) throw new ForgeError('NOT_FOUND', `Session not found: ${id}`);
    return sess;
  }

  list(): Session[] {
    return this.store.listDocs<Session>(KIND);
  }

  close(id: string): Session {
    const sess = this.get(id);
    sess.status = 'closed';
    sess.updatedAt = nowIso();
    this.save(sess);
    this.bus?.emit({ type: 'session.closed', sessionId: sess.id, data: {} });
    return sess;
  }

  attach(id: string, patch: { agentId?: AgentId; taskId?: TaskId; teamId?: TeamId; lastEventSeq?: number }): Session {
    const sess = this.get(id);
    if (patch.agentId && !sess.agentIds.includes(patch.agentId)) sess.agentIds.push(patch.agentId);
    if (patch.taskId && !sess.taskIds.includes(patch.taskId)) sess.taskIds.push(patch.taskId);
    if (patch.teamId && !sess.teamIds.includes(patch.teamId)) sess.teamIds.push(patch.teamId);
    if (patch.lastEventSeq !== undefined) sess.lastEventSeq = patch.lastEventSeq;
    sess.updatedAt = nowIso();
    this.save(sess);
    return sess;
  }

  save(sess: Session): void {
    this.store.putDoc(KIND, sess.id, sess.id, sess.updatedAt, sess);
  }
}
