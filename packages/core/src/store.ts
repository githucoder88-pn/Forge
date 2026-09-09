import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ForgeError,
  type Agent,
  type AgentId,
  type EventEnvelope,
  type EventId,
  type Message,
  type Session,
  type SessionId,
  type Task,
  type ToolCallId,
} from "@forge/protocol";

const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_root TEXT NOT NULL,
    title TEXT NOT NULL, config_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0, active_agent_id TEXT
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    name TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL,
    state TEXT NOT NULL, current_task TEXT, workspace_id TEXT NOT NULL,
    permissions_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0, metrics_json TEXT NOT NULL,
    last_error TEXT, parent_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    agent_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    agent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
    tool_call_id TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
    type TEXT NOT NULL, ts TEXT NOT NULL, payload_json TEXT NOT NULL, causation_id TEXT,
    UNIQUE(session_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
  CREATE TABLE IF NOT EXISTS tool_runs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    agent_id TEXT, tool TEXT NOT NULL, input_json TEXT NOT NULL,
    ok INTEGER NOT NULL, output_json TEXT, error TEXT,
    started_at TEXT NOT NULL, ended_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_toolruns_session ON tool_runs(session_id);
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    agent_id TEXT, tool TEXT NOT NULL, input_json TEXT NOT NULL, reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, resolved_at TEXT
  );
  `,
];

export interface ToolRun {
  id: ToolCallId;
  sessionId: SessionId;
  agentId: AgentId | null;
  tool: string;
  input: unknown;
  ok: boolean;
  output?: unknown;
  error?: string;
  startedAt: string;
  endedAt?: string;
}

export interface Approval {
  id: string;
  sessionId: SessionId;
  agentId: AgentId | null;
  tool: string;
  input: unknown;
  reason: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  resolvedAt?: string;
}

/** SQLite-backed persistence. Normalized tables + versioned JSON payloads for events. */
export class Store {
  private db: DatabaseSync;
  private closed = false;
  readonly path: string;

  constructor(dataDir: string, filename = "forge.db") {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, filename);
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(MIGRATIONS[0]!);
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    const current = row ? Number(row.value) : 0;
    if (current < SCHEMA_VERSION) {
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    }
  }

  // ---- sessions ----
  saveSession(s: Session): void {
    try {
      this.db
        .prepare(
          `INSERT INTO sessions (id, workspace_id, workspace_root, title, config_json, created_at, updated_at, last_seq, active_agent_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, config_json=excluded.config_json,
             updated_at=excluded.updated_at, last_seq=excluded.last_seq, active_agent_id=excluded.active_agent_id`,
        )
        .run(s.id, s.workspaceId, s.workspaceRoot, s.title, JSON.stringify(s.config), s.createdAt, s.updatedAt, s.lastSeq, s.activeAgentId);
    } catch (e) {
      throw new ForgeError("PersistenceFailure", `saveSession failed: ${(e as Error).message}`, { cause: e });
    }
  }

  getSession(id: SessionId): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapSession(row) : null;
  }

  listSessions(limit = 50, offset = 0): Session[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Record<string, unknown>[];
    return rows.map((r) => this.mapSession(r));
  }

  private mapSession(r: Record<string, unknown>): Session {
    return {
      id: r.id as SessionId,
      workspaceId: r.workspace_id as Session["workspaceId"],
      workspaceRoot: r.workspace_root as string,
      title: r.title as string,
      config: JSON.parse(r.config_json as string) as Session["config"],
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      lastSeq: r.last_seq as number,
      activeAgentId: (r.active_agent_id as AgentId | null) ?? null,
    };
  }

  // ---- agents ----
  saveAgent(a: Agent): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agents (id, session_id, name, role, model, provider, state, current_task, workspace_id, permissions_json, created_at, updated_at, progress, metrics_json, last_error, parent_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET state=excluded.state, current_task=excluded.current_task,
             updated_at=excluded.updated_at, progress=excluded.progress, metrics_json=excluded.metrics_json,
             last_error=excluded.last_error, permissions_json=excluded.permissions_json`,
        )
        .run(a.id, a.sessionId, a.name, a.role, a.model, a.provider, a.state, a.currentTask, a.workspaceId,
          JSON.stringify(a.permissions), a.createdAt, a.updatedAt, a.progress, JSON.stringify(a.metrics),
          a.lastError ?? null, a.parentAgent ?? null);
    } catch (e) {
      throw new ForgeError("PersistenceFailure", `saveAgent failed: ${(e as Error).message}`, { cause: e });
    }
  }

  getAgent(id: AgentId): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapAgent(row) : null;
  }

  listAgents(sessionId: SessionId): Agent[] {
    const rows = this.db.prepare("SELECT * FROM agents WHERE session_id=? ORDER BY created_at ASC").all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.mapAgent(r));
  }

  private mapAgent(r: Record<string, unknown>): Agent {
    return {
      id: r.id as AgentId,
      sessionId: r.session_id as SessionId,
      name: r.name as string,
      role: r.role as string,
      model: r.model as string,
      provider: r.provider as string,
      state: r.state as Agent["state"],
      currentTask: (r.current_task as Agent["currentTask"]) ?? null,
      workspaceId: r.workspace_id as Agent["workspaceId"],
      permissions: JSON.parse(r.permissions_json as string) as Agent["permissions"],
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      progress: r.progress as number,
      metrics: JSON.parse(r.metrics_json as string) as Agent["metrics"],
      lastError: (r.last_error as string | null) ?? undefined,
      parentAgent: (r.parent_agent as AgentId | null) ?? undefined,
    };
  }

  // ---- tasks & messages ----
  saveTask(t: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, session_id, agent_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id, title=excluded.title, status=excluded.status, updated_at=excluded.updated_at`,
      )
      .run(t.id, t.sessionId, t.agentId, t.title, t.status, t.createdAt, t.updatedAt);
  }

  listTasks(sessionId: SessionId): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE session_id=? ORDER BY created_at ASC").all(sessionId) as Record<string, unknown>[]).map((r) => ({
      id: r.id as Task["id"],
      sessionId: r.session_id as SessionId,
      agentId: (r.agent_id as Task["agentId"]) ?? null,
      title: r.title as string,
      status: r.status as Task["status"],
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  }

  saveMessage(m: Message): void {
    this.db
      .prepare("INSERT INTO messages (id, session_id, agent_id, role, content, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.sessionId, m.agentId, m.role, m.content, m.toolCallId ?? null, m.createdAt);
  }

  listMessages(sessionId: SessionId, limit = 500): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC LIMIT ?").all(sessionId, limit) as Record<string, unknown>[]).map((r) => ({
      id: r.id as Message["id"],
      sessionId: r.session_id as SessionId,
      agentId: (r.agent_id as Message["agentId"]) ?? null,
      role: r.role as Message["role"],
      content: r.content as string,
      toolCallId: (r.tool_call_id as ToolCallId | null) ?? undefined,
      createdAt: r.created_at as string,
    }));
  }

  // ---- events ----
  /** Allocate next seq + persist event atomically. Returns the stored envelope. */
  appendEvent<T extends EventEnvelope>(e: Omit<T, "seq"> & { seq?: never }): T {
    const get = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id=?").get(e.sessionId) as { m: number };
    const seq = get.m + 1;
    const full = { ...e, seq } as T;
    this.db
      .prepare("INSERT INTO events (id, seq, session_id, type, ts, payload_json, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(full.id, seq, full.sessionId, full.type, full.ts, JSON.stringify(full.payload), full.causationId ?? null);
    this.db.prepare("UPDATE sessions SET last_seq=?, updated_at=? WHERE id=?").run(seq, new Date().toISOString(), full.sessionId);
    return full;
  }

  listEvents(sessionId: SessionId, afterSeq = 0, limit = 1000): EventEnvelope[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT ?").all(sessionId, afterSeq, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as EventId,
      seq: r.seq as number,
      ts: r.ts as string,
      protocol: "1.0",
      sessionId: r.session_id as SessionId,
      type: r.type as EventEnvelope["type"],
      payload: JSON.parse(r.payload_json as string) as unknown,
      ...(r.causation_id ? { causationId: r.causation_id as EventId } : {}),
    }));
  }

  // ---- tool runs ----
  saveToolRun(t: ToolRun): void {
    this.db
      .prepare(
        `INSERT INTO tool_runs (id, session_id, agent_id, tool, input_json, ok, output_json, error, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ok=excluded.ok, output_json=excluded.output_json, error=excluded.error, ended_at=excluded.ended_at`,
      )
      .run(t.id, t.sessionId, t.agentId, t.tool, JSON.stringify(t.input), t.ok ? 1 : 0,
        t.output === undefined ? null : JSON.stringify(t.output), t.error ?? null, t.startedAt, t.endedAt ?? null);
  }

  // ---- approvals ----
  saveApproval(a: Approval): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, agent_id, tool, input_json, reason, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, resolved_at=excluded.resolved_at`,
      )
      .run(a.id, a.sessionId, a.agentId, a.tool, JSON.stringify(a.input), a.reason, a.status, a.createdAt, a.resolvedAt ?? null);
  }

  getApproval(id: string): Approval | null {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      sessionId: r.session_id as SessionId,
      agentId: (r.agent_id as AgentId | null) ?? null,
      tool: r.tool as string,
      input: JSON.parse(r.input_json as string) as unknown,
      reason: r.reason as string,
      status: r.status as Approval["status"],
      createdAt: r.created_at as string,
      resolvedAt: (r.resolved_at as string | null) ?? undefined,
    };
  }
}
