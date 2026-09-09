/**
 * @forge/protocol-client — typed client for the Forge protocol.
 * Zero runtime dependencies; runs in Node, browsers, Electron and Tauri.
 */
import type {
  AgentDTO, ApprovalDTO, CheckpointDTO, ForgeMethod, MessageDTO,
  SessionDTO, TaskDTO, TeamDTO,
} from '@forge/protocol';

export interface ForgeEventDTO {
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
}

export interface EventFilter {
  types?: string[];
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  teamId?: string;
}

export class ForgeClientError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ForgeClientError';
    this.code = code;
    this.data = data;
  }
}

export interface ForgeClientOptions {
  url: string;
  token?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

let nextId = 1;

export class ForgeClient {
  readonly url: string;
  private token?: string;
  private fetchFn: typeof fetch;
  private timeoutMs: number;

  constructor(opts: ForgeClientOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  async health(): Promise<{ ok: boolean; protocol: string; uptimeMs: number; projectDir: string; eventSeq: number }> {
    const res = await this.fetchFn(`${this.url}/health`, { headers: this.authHeaders() });
    if (!res.ok) throw new ForgeClientError(res.status, `health check failed: HTTP ${res.status}`);
    return (await res.json()) as { ok: boolean; protocol: string; uptimeMs: number; projectDir: string; eventSeq: number };
  }

  async rpc<T = unknown>(method: ForgeMethod, params?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: params ?? {} }),
        signal: controller.signal,
      });
      if (res.status === 401) throw new ForgeClientError(401, 'Unauthorized — provide a valid FORGE_TOKEN');
      const json = await res.json() as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (json.error) throw new ForgeClientError(json.error.code, json.error.message, json.error.data);
      return json.result as T;
    } catch (e) {
      if (e instanceof ForgeClientError) throw e;
      throw new ForgeClientError(-1, `Request failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  /**
   * Subscribe to the live event stream over WebSocket with replay catch-up.
   * Returns an unsubscribe function. Uses global WebSocket (Node 22+ / browsers).
   */
  subscribeEvents(opts: {
    filter?: EventFilter;
    sinceSeq?: number;
    onEvent: (e: ForgeEventDTO) => void;
    onStatus?: (status: 'connected' | 'disconnected' | 'error', detail?: string) => void;
  }): () => void {
    const wsUrl = this.url.replace(/^http/, 'ws') + (this.token ? `/ws?token=${encodeURIComponent(this.token)}` : '/ws');
    const ws = new WebSocket(wsUrl);
    let closed = false;
    ws.onopen = () => {
      opts.onStatus?.('connected');
      ws.send(JSON.stringify({ type: 'subscribe', filter: opts.filter ?? {} }));
      if (opts.sinceSeq !== undefined) ws.send(JSON.stringify({ type: 'replay', sinceSeq: opts.sinceSeq }));
    };
    ws.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(String(msg.data)) as { method?: string; params?: ForgeEventDTO };
        if (parsed.method === 'event' && parsed.params) opts.onEvent(parsed.params);
      } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => { if (!closed) opts.onStatus?.('disconnected'); };
    ws.onerror = () => opts.onStatus?.('error');
    return () => {
      closed = true;
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  // ---------------------------------------------------------- typed API ---

  sessionCreate(params: { name?: string; projectDir?: string } = {}): Promise<SessionDTO> {
    return this.rpc('session.create', params);
  }
  sessionResume(sessionId: string): Promise<SessionDTO> {
    return this.rpc('session.resume', { sessionId });
  }
  sessionList(): Promise<SessionDTO[]> {
    return this.rpc('session.list');
  }
  sessionGet(sessionId: string): Promise<SessionDTO> {
    return this.rpc('session.get', { sessionId });
  }
  sessionClose(sessionId: string): Promise<SessionDTO> {
    return this.rpc('session.close', { sessionId });
  }

  agentCreate(params: { sessionId: string; name: string; role?: string; capabilities?: string[]; model?: { provider: string; model: string }; autonomy?: string; teamId?: string; goal?: string }): Promise<AgentDTO> {
    return this.rpc('agent.create', params);
  }
  agentList(sessionId?: string): Promise<AgentDTO[]> {
    return this.rpc('agent.list', sessionId ? { sessionId } : {});
  }
  agentGet(agentId: string): Promise<AgentDTO> {
    return this.rpc('agent.get', { agentId });
  }
  agentStart(agentId: string, goal: string, params: { taskId?: string; maxIterations?: number; budgetTokens?: number; model?: { provider: string; model: string }; files?: string[] } = {}): Promise<{ accepted: boolean; agentId: string }> {
    return this.rpc('agent.start', { agentId, goal, ...params });
  }
  agentPause(agentId: string): Promise<AgentDTO> { return this.rpc('agent.pause', { agentId }); }
  agentResume(agentId: string): Promise<AgentDTO> { return this.rpc('agent.resume', { agentId }); }
  agentCancel(agentId: string): Promise<AgentDTO> { return this.rpc('agent.cancel', { agentId }); }
  agentSpawn(parentAgentId: string, params: { name: string; goal: string; role?: string; parentSummary?: string; files?: string[] }): Promise<AgentDTO> {
    return this.rpc('agent.spawn', { parentAgentId, ...params });
  }

  taskCreate(params: { sessionId: string; title: string; description?: string; priority?: number; dependsOn?: string[]; ownerAgentId?: string; teamId?: string; maxRetries?: number }): Promise<TaskDTO> {
    return this.rpc('task.create', params);
  }
  taskList(sessionId?: string): Promise<TaskDTO[]> {
    return this.rpc('task.list', sessionId ? { sessionId } : {});
  }
  taskGet(taskId: string): Promise<TaskDTO> {
    return this.rpc('task.get', { taskId });
  }
  taskRun(sessionId: string, params: { only?: string[]; maxParallel?: number } = {}): Promise<{ accepted: boolean }> {
    return this.rpc('task.run', { sessionId, ...params });
  }

  teamCreate(params: { sessionId: string; name: string; managerAgentId?: string; sharedGoal?: string }): Promise<TeamDTO> {
    return this.rpc('team.create', params);
  }
  teamList(sessionId?: string): Promise<TeamDTO[]> {
    return this.rpc('team.list', sessionId ? { sessionId } : {});
  }
  teamGet(teamId: string): Promise<TeamDTO> {
    return this.rpc('team.get', { teamId });
  }
  teamStatus(teamId: string): Promise<unknown> {
    return this.rpc('team.status', { teamId });
  }

  messageSend(params: { from: string; to: string; type: string; body: string; subject?: string; sessionId?: string; teamId?: string; taskId?: string }): Promise<MessageDTO> {
    return this.rpc('message.send', params);
  }
  conversation(params: { sessionId?: string; teamId?: string; taskId?: string; limit?: number } = {}): Promise<MessageDTO[]> {
    return this.rpc('message.conversation', params);
  }

  toolList(): Promise<{ name: string; description: string }[]> {
    return this.rpc('tool.list');
  }
  toolInvoke(tool: string, input: Record<string, unknown> = {}, params: { sessionId?: string; agentId?: string; taskId?: string } = {}): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string }; durationMs: number }> {
    return this.rpc('tool.invoke', { tool, input, ...params });
  }

  workspaceList(path = '.', params: { sessionId?: string; recursive?: boolean; maxEntries?: number } = {}): Promise<{ entries: { name: string; path: string; type: string; size: number }[] }> {
    return this.rpc('workspace.list', { path, ...params });
  }
  workspaceRead(path: string, sessionId?: string): Promise<{ path: string; content: string }> {
    return this.rpc('workspace.read', sessionId ? { path, sessionId } : { path });
  }

  modelStatus(): Promise<unknown> {
    return this.rpc('model.status');
  }
  checkpointCreate(sessionId: string, label: string): Promise<CheckpointDTO> {
    return this.rpc('checkpoint.create', { sessionId, label });
  }
  checkpointList(sessionId?: string): Promise<CheckpointDTO[]> {
    return this.rpc('checkpoint.list', sessionId ? { sessionId } : {});
  }
  checkpointRestore(checkpointId: string, params: { restoreGit?: boolean; allowDirtyRestore?: boolean } = {}): Promise<CheckpointDTO> {
    return this.rpc('checkpoint.restore', { checkpointId, ...params });
  }

  approvalList(): Promise<ApprovalDTO[]> {
    return this.rpc('approval.list');
  }
  approvalResolve(approvalId: string, approved: boolean): Promise<ApprovalDTO> {
    return this.rpc('approval.resolve', { approvalId, approved });
  }

  eventsReplay(params: { sessionId?: string; sinceSeq?: number; types?: string[]; limit?: number } = {}): Promise<ForgeEventDTO[]> {
    return this.rpc('events.replay', params);
  }
  runtimeStatus(): Promise<unknown> {
    return this.rpc('runtime.status');
  }
  configGet(): Promise<unknown> {
    return this.rpc('config.get');
  }
}
