import {
  ForgeError,
  PROTOCOL_VERSION,
  type Agent,
  type AgentId,
  type EventEnvelope,
  type RpcMethod,
  type RpcResponse,
  type Session,
  type SessionId,
  type SessionSnapshot,
} from "@forge/protocol";

export interface ClientOpts {
  token?: string;
  timeoutMs?: number;
}

export interface Subscription {
  close: () => void;
  readonly lastSeq: number;
}

/**
 * Typed Forge Core client (Node + browser). Plain fetch for RPC, global
 * WebSocket for the event stream. No agent/tool logic lives here — render
 * and request operations only.
 */
export class ForgeClient {
  private rpcId = 0;
  readonly baseUrl: string;
  private token?: string;
  private timeoutMs: number;

  constructor(baseUrl: string, opts: ClientOpts = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const envToken = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.FORGE_TOKEN;
    this.token = opts.token ?? envToken;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async call<T = unknown>(method: RpcMethod, params?: unknown): Promise<T> {
    const id = ++this.rpcId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`rpc ${method} timed out`)), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/rpc`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {}, protocol: PROTOCOL_VERSION }),
        signal: controller.signal,
      });
      const data = (await res.json()) as RpcResponse<T>;
      if ("error" in data) {
        throw new ForgeError(
          (data.error.data?.forgeCode ?? "ProtocolFailure") as ForgeError["code"],
          data.error.message,
          { details: { codeNumber: data.error.code, ...(typeof data.error.data?.details === "object" ? (data.error.data.details as Record<string, unknown>) : {}) }, retryable: data.error.data?.retryable },
        );
      }
      return data.result;
    } catch (e) {
      if (ForgeError.isForgeError(e)) throw e;
      if (e instanceof Error && e.name === "AbortError") throw new ForgeError("Timeout", `rpc ${method} timed out`, { cause: e });
      throw new ForgeError("ProviderUnavailable", `core unreachable at ${this.baseUrl}: ${(e as Error).message}`, { cause: e });
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ ok: boolean; version: string; protocol: string; uptimeMs: number }> {
    const res = await fetch(`${this.baseUrl}/health`, { headers: this.headers() });
    if (!res.ok) throw new ForgeError("ProviderUnavailable", `core health check failed: ${res.status}`);
    return (await res.json()) as { ok: boolean; version: string; protocol: string; uptimeMs: number };
  }

  // ---- typed convenience wrappers ----
  createSession(params: { workspaceRoot: string; title?: string; provider?: string; model?: string; permissions?: { mode?: "read-only" | "workspace-write" | "full-workspace"; approval?: "always" | "risky-only" | "never" }; maxIterations?: number }): Promise<Session> {
    return this.call<Session>("create_session", params);
  }
  getSession(sessionId: SessionId): Promise<Session> {
    return this.call<Session>("get_session", { sessionId });
  }
  listSessions(limit = 50, offset = 0): Promise<{ sessions: Session[] }> {
    return this.call("list_sessions", { limit, offset });
  }
  resumeSession(sessionId: SessionId, afterSeq = 0): Promise<{ snapshot: SessionSnapshot; events: EventEnvelope[] }> {
    return this.call("resume_session", { sessionId, afterSeq });
  }
  sendMessage(sessionId: SessionId, content: string, agentId?: AgentId): Promise<{ agentId: AgentId; accepted: boolean }> {
    return this.call("send_message", agentId ? { sessionId, content, agentId } : { sessionId, content });
  }
  getAgent(agentId: AgentId): Promise<Agent> {
    return this.call<Agent>("get_agent", { agentId });
  }
  getSessionState(sessionId: SessionId, afterSeq = 0): Promise<{ snapshot: SessionSnapshot; events: EventEnvelope[] }> {
    return this.call("get_session_state", { sessionId, afterSeq });
  }
  cancelAgent(agentId: AgentId, reason?: string): Promise<{ cancelled: boolean }> {
    return this.call("cancel_agent", { agentId, reason });
  }
  resolveApproval(approvalId: string, approved: boolean): Promise<{ resolved: boolean }> {
    return this.call("resolve_approval", { approvalId, approved });
  }

  /**
   * Subscribe to a session event stream over WebSocket. Auto-reconnects with
   * backoff and resumes from the last seen seq (bounded attempts).
   */
  subscribe(
    sessionId: SessionId,
    onEvent: (e: EventEnvelope) => void,
    opts: { afterSeq?: number; signal?: AbortSignal; maxRetries?: number } = {},
  ): Subscription {
    let lastSeq = opts.afterSeq ?? 0;
    let retries = 0;
    const maxRetries = opts.maxRetries ?? 10;
    let ws: WebSocket | null = null;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const sub: Subscription = {
      close: () => {
        closed = true;
        if (retryTimer) clearTimeout(retryTimer);
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      },
      get lastSeq() {
        return lastSeq;
      },
    };

    const connect = (): void => {
      if (closed || opts.signal?.aborted) return;
      const wsUrl = this.baseUrl.replace(/^http/, "ws") + `/ws${this.token ? `?token=${encodeURIComponent(this.token)}` : ""}`;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        scheduleRetry();
        return;
      }
      ws.onopen = () => {
        retries = 0;
        ws?.send(JSON.stringify({ jsonrpc: "2.0", id: `sub-${Date.now()}`, method: "stream_events", params: { sessionId, afterSeq: lastSeq } }));
      };
      ws.onmessage = (msg) => {
        let data: { method?: string; id?: unknown; params?: EventEnvelope; error?: unknown };
        try {
          data = JSON.parse(String(msg.data)) as typeof data;
        } catch {
          return;
        }
        if (data.method === "event" && data.params) {
          lastSeq = Math.max(lastSeq, data.params.seq);
          try {
            onEvent(data.params);
          } catch {
            /* subscriber error must not kill the stream */
          }
        }
      };
      ws.onclose = () => {
        ws = null;
        if (!closed && !opts.signal?.aborted) scheduleRetry();
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* onclose will retry */
        }
      };
    };

    const scheduleRetry = (): void => {
      if (closed || opts.signal?.aborted || retries >= maxRetries) return;
      retries++;
      const delay = Math.min(1000 * 2 ** (retries - 1), 10_000);
      retryTimer = setTimeout(connect, delay);
    };

    opts.signal?.addEventListener("abort", () => sub.close(), { once: true });
    connect();
    return sub;
  }
}
