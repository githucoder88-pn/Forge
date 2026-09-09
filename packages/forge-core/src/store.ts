/**
 * SQLite-backed persistence (node:sqlite). Sessions, agents, tasks, teams,
 * messages, memory, checkpoints, events and file attribution survive restarts
 * so `session resume` and `rollback` work from real persisted state.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ForgeError } from './errors.js';
import type { ForgeEvent } from './events.js';

export interface StoreOptions {
  /** Path to the sqlite file, or ':memory:'. */
  path: string;
}

export class SqliteStore {
  private db: DatabaseSync;
  readonly path: string;

  constructor(opts: StoreOptions) {
    this.path = opts.path;
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
    try {
      this.db = new DatabaseSync(opts.path);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      this.migrate();
    } catch (e) {
      throw new ForgeError('STORE_ERROR', `Failed to open store at ${opts.path}: ${(e as Error).message}`, { cause: e });
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs (
        kind TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT,
        updated_at TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX IF NOT EXISTS idx_docs_session ON docs (kind, session_id);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL, ts TEXT NOT NULL,
        type TEXT NOT NULL, session_id TEXT, agent_id TEXT, task_id TEXT, team_id TEXT,
        simulated INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, seq);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT, team_id TEXT, task_id TEXT,
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL,
        ts TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages (session_id, to_id, ts);
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT NOT NULL,
        key TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory (scope, scope_id);
      CREATE TABLE IF NOT EXISTS file_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, path TEXT NOT NULL,
        op TEXT NOT NULL, agent_id TEXT, task_id TEXT, session_id TEXT, checkpoint_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_file_events_path ON file_events (path, id);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- key/value ----
  kvGet(key: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
    return row?.v;
  }
  kvSet(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
  }
  kvDel(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE k = ?').run(key);
  }

  // ---- generic docs (sessions/agents/tasks/teams/checkpoints) ----
  putDoc(kind: string, id: string, sessionId: string | undefined, updatedAt: string, data: unknown): void {
    this.db.prepare(
      'INSERT INTO docs (kind, id, session_id, updated_at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at, data = excluded.data',
    ).run(kind, id, sessionId ?? null, updatedAt, JSON.stringify(data));
  }

  getDoc<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM docs WHERE kind = ? AND id = ?').get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  listDocs<T>(kind: string, sessionId?: string, limit = 1000): T[] {
    const rows = (sessionId === undefined
      ? this.db.prepare('SELECT data FROM docs WHERE kind = ? ORDER BY updated_at DESC LIMIT ?').all(kind, limit)
      : this.db.prepare('SELECT data FROM docs WHERE kind = ? AND session_id = ? ORDER BY updated_at DESC LIMIT ?').all(kind, sessionId, limit)) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  deleteDoc(kind: string, id: string): void {
    this.db.prepare('DELETE FROM docs WHERE kind = ? AND id = ?').run(kind, id);
  }

  // ---- events ----
  saveEvent(e: ForgeEvent): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO events (seq, id, ts, type, session_id, agent_id, task_id, team_id, simulated, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(e.seq, e.id, e.ts, e.type, e.sessionId ?? null, e.agentId ?? null, e.taskId ?? null, e.teamId ?? null, e.simulated ? 1 : 0, JSON.stringify(e.data));
  }

  maxEventSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number | null };
    return row.m ?? 0;
  }

  loadEvents(opts: { sessionId?: string; sinceSeq?: number; types?: string[]; limit?: number } = {}): ForgeEvent[] {
    const conds: string[] = [];
    const args: (string | number | null)[] = [];
    if (opts.sessionId !== undefined) { conds.push('session_id = ?'); args.push(opts.sessionId); }
    if (opts.sinceSeq !== undefined) { conds.push('seq > ?'); args.push(opts.sinceSeq); }
    if (opts.types && opts.types.length > 0) {
      conds.push(`type IN (${opts.types.map(() => '?').join(',')})`);
      args.push(...opts.types);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT seq, id, ts, type, session_id, agent_id, task_id, team_id, simulated, data FROM events ${where} ORDER BY seq ASC LIMIT ?`).all(...args, opts.limit ?? 1000) as {
      seq: number; id: string; ts: string; type: string; session_id: string | null; agent_id: string | null; task_id: string | null; team_id: string | null; simulated: number; data: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq, id: r.id as ForgeEvent['id'], v: 1 as const, ts: r.ts, type: r.type as ForgeEvent['type'],
      sessionId: (r.session_id ?? undefined) as ForgeEvent['sessionId'],
      agentId: (r.agent_id ?? undefined) as ForgeEvent['agentId'],
      taskId: (r.task_id ?? undefined) as ForgeEvent['taskId'],
      teamId: (r.team_id ?? undefined) as ForgeEvent['teamId'],
      simulated: r.simulated ? true : undefined,
      data: JSON.parse(r.data) as unknown,
    }));
  }

  // ---- messages ----
  saveMessage(m: { id: string; sessionId?: string; teamId?: string; taskId?: string; from: string; to: string; type: string; ts: string; body: unknown }): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO messages (id, session_id, team_id, task_id, from_id, to_id, type, ts, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(m.id, m.sessionId ?? null, m.teamId ?? null, m.taskId ?? null, m.from, m.to, m.type, m.ts, JSON.stringify(m.body));
  }

  loadMessages(opts: { sessionId?: string; to?: string; from?: string; limit?: number } = {}): { id: string; data: unknown }[] {
    const conds: string[] = [];
    const args: (string | number | null)[] = [];
    if (opts.sessionId !== undefined) { conds.push('session_id = ?'); args.push(opts.sessionId); }
    if (opts.to !== undefined) { conds.push('(to_id = ? OR to_id = ?)'); args.push(opts.to, '*'); }
    if (opts.from !== undefined) { conds.push('from_id = ?'); args.push(opts.from); }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT id, data FROM messages ${where} ORDER BY ts ASC LIMIT ?`).all(...args, opts.limit ?? 500) as { id: string; data: string }[];
    return rows.map((r) => ({ id: r.id, data: JSON.parse(r.data) as unknown }));
  }

  // ---- memory ----
  putMemory(m: { id: string; scope: string; scopeId: string; key: string; updatedAt: string; data: unknown }): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO memory (id, scope, scope_id, key, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(m.id, m.scope, m.scopeId, m.key, m.updatedAt, JSON.stringify(m.data));
  }

  getMemory(id: string): unknown {
    const row = this.db.prepare('SELECT data FROM memory WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as unknown) : undefined;
  }

  searchMemory(opts: { scope?: string; scopeId?: string; query?: string; limit?: number }): unknown[] {
    const conds: string[] = [];
    const args: (string | number | null)[] = [];
    if (opts.scope !== undefined) { conds.push('scope = ?'); args.push(opts.scope); }
    if (opts.scopeId !== undefined) { conds.push('scope_id = ?'); args.push(opts.scopeId); }
    if (opts.query) { conds.push('data LIKE ?'); args.push(`%${opts.query.replace(/%/g, '%%')}%`); }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT data FROM memory ${where} ORDER BY updated_at DESC LIMIT ?`).all(...args, opts.limit ?? 100) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as unknown);
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memory WHERE id = ?').run(id);
  }

  // ---- file attribution: who changed this file and why ----
  recordFileEvent(e: { ts: string; path: string; op: string; agentId?: string; taskId?: string; sessionId?: string; checkpointId?: string }): void {
    this.db.prepare(
      'INSERT INTO file_events (ts, path, op, agent_id, task_id, session_id, checkpoint_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(e.ts, e.path, e.op, e.agentId ?? null, e.taskId ?? null, e.sessionId ?? null, e.checkpointId ?? null);
  }

  fileHistory(path: string, limit = 50): { ts: string; path: string; op: string; agentId?: string; taskId?: string; sessionId?: string; checkpointId?: string }[] {
    const rows = this.db.prepare(
      'SELECT ts, path, op, agent_id, task_id, session_id, checkpoint_id FROM file_events WHERE path = ? ORDER BY id DESC LIMIT ?',
    ).all(path, limit) as { ts: string; path: string; op: string; agent_id: string | null; task_id: string | null; session_id: string | null; checkpoint_id: string | null }[];
    return rows.map((r) => ({
      ts: r.ts, path: r.path, op: r.op,
      agentId: r.agent_id ?? undefined, taskId: r.task_id ?? undefined,
      sessionId: r.session_id ?? undefined, checkpointId: r.checkpoint_id ?? undefined,
    }));
  }
}
