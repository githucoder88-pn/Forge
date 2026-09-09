import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  ForgeError,
  PARAM_SCHEMAS,
  PROTOCOL_VERSION,
  RpcRequestSchema,
  type AgentId,
  type EventEnvelope,
  type RpcMethod,
  type RpcResponse,
  type SessionId,
} from "@forge/protocol";
import type { ForgeApp } from "./app.ts";

const VERSION = "0.1.0";
const MAX_BODY_BYTES = 5_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function toFailure(id: string | number, e: unknown): RpcResponse {
  const err = ForgeError.fromUnknown(e);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: err.codeNumber,
      message: err.message,
      data: { forgeCode: err.code, retryable: err.retryable, ...(err.details ? { details: err.details } : {}) },
    },
    protocol: PROTOCOL_VERSION,
  };
}

/** Local Core server: JSON-RPC over HTTP POST /rpc + multiplexed WebSocket /ws. */
export class CoreServer {
  private http: Server;
  private wss: WebSocketServer;
  private startedAt = Date.now();
  private closed = false;

  private app: ForgeApp;
  constructor(app: ForgeApp) {
    this.app = app;
    this.http = createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });
    this.wss.on("connection", (ws, req) => this.handleWs(ws, req));
  }

  get url(): string {
    return `http://${this.app.config.host}:${this.app.config.port}`;
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    const { host, port } = this.app.config;
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, host, () => {
        this.http.removeListener("error", reject);
        resolve();
      });
    });
    const addr = this.http.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    this.app.log.info(`forge core listening on ${host}:${actualPort}`, {});
    return { host, port: actualPort, url: `http://${host}:${actualPort}` };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const ws of this.wss.clients) {
      try {
        ws.close(1001, "server closing");
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      this.http.close((e) => (e ? reject(e) : resolve()));
    });
    this.app.close();
  }

  // ---------- auth ----------
  private authorized(req: IncomingMessage, url: URL): boolean {
    const token = process.env.FORGE_TOKEN;
    if (!token) return true; // loopback-trusted local mode
    const header = req.headers.authorization;
    if (header === `Bearer ${token}`) return true;
    return url.searchParams.get("token") === token;
  }

  // ---------- http ----------
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, await this.dispatch("health", {}, "http"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        sendJson(res, 200, { name: "forge-core", version: VERSION, protocol: PROTOCOL_VERSION, rpc: "/rpc", websocket: "/ws", health: "/health" });
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/rpc") {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (!this.authorized(req, url)) {
        sendJson(res, 401, toFailure(0, new ForgeError("PermissionDenied", "missing or invalid FORGE_TOKEN")));
        return;
      }
      const raw = await readBody(req, MAX_BODY_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, toFailure(0, new ForgeError("ProtocolFailure", "invalid JSON body")));
        return;
      }
      const reqCheck = RpcRequestSchema.safeParse(parsed);
      if (!reqCheck.success) {
        sendJson(res, 400, toFailure((parsed as { id?: string | number }).id ?? 0, new ForgeError("ProtocolFailure", `invalid JSON-RPC request: ${reqCheck.error.message}`)));
        return;
      }
      // Client disconnect cancels the in-flight call.
      const controller = new AbortController();
      req.on("close", () => controller.abort(new Error("client disconnected")));
      try {
        const result = await this.dispatch(reqCheck.data.method as RpcMethod, reqCheck.data.params, "http", controller.signal);
        const ok: RpcResponse = { jsonrpc: "2.0", id: reqCheck.data.id, result, protocol: PROTOCOL_VERSION };
        sendJson(res, 200, ok);
      } catch (e) {
        sendJson(res, 200, toFailure(reqCheck.data.id, e));
      } finally {
        controller.abort(new Error("request finished"));
      }
    } catch (e) {
      try {
        sendJson(res, 500, toFailure(0, e));
      } catch {
        /* socket gone */
      }
    }
  }

  // ---------- websocket ----------
  private handleWs(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    if (!this.authorized(req, url)) {
      ws.close(4401, "unauthorized");
      return;
    }
    const unsubs: (() => void)[] = [];
    const controllers = new Set<AbortController>();
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        ws.send(JSON.stringify(toFailure(0, new ForgeError("ProtocolFailure", "invalid JSON"))));
        return;
      }
      const reqCheck = RpcRequestSchema.safeParse(parsed);
      if (!reqCheck.success) {
        ws.send(JSON.stringify(toFailure(0, new ForgeError("ProtocolFailure", "invalid JSON-RPC request"))));
        return;
      }
      const controller = new AbortController();
      controllers.add(controller);
      const id = reqCheck.data.id;
      if (reqCheck.data.method === "stream_events") {
        const schema = PARAM_SCHEMAS.stream_events;
        const p = schema.safeParse(reqCheck.data.params);
        if (!p.success) {
          ws.send(JSON.stringify(toFailure(id, new ForgeError("InvalidRequest", p.error.message))));
          controllers.delete(controller);
          return;
        }
        const { sessionId, afterSeq } = p.data as { sessionId: SessionId; afterSeq?: number };
        try {
          this.app.sessions.getSession(sessionId); // validates existence
        } catch (e) {
          ws.send(JSON.stringify(toFailure(id, e)));
          controllers.delete(controller);
          return;
        }
        const push = (e: EventEnvelope): void => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: e }));
          }
        };
        const unsub = this.app.bus.subscribe(sessionId, push, afterSeq ?? 0);
        unsubs.push(unsub);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: { subscribed: sessionId }, protocol: PROTOCOL_VERSION }));
        controllers.delete(controller);
        return;
      }
      void this.dispatch(reqCheck.data.method as RpcMethod, reqCheck.data.params, "ws", controller.signal).then(
        (result) => {
          controllers.delete(controller);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, result, protocol: PROTOCOL_VERSION }));
          }
        },
        (e: unknown) => {
          controllers.delete(controller);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(toFailure(id, e)));
        },
      );
    });
    ws.on("close", () => {
      for (const u of unsubs.splice(0)) {
        try {
          u();
        } catch {
          /* ignore */
        }
      }
      for (const c of controllers) c.abort(new Error("websocket closed"));
      controllers.clear();
    });
    ws.on("error", () => {
      /* connection-level; close handler cleans up */
    });
  }

  // ---------- dispatch ----------
  async dispatch(method: string, params: unknown, transport: "http" | "ws", signal?: AbortSignal): Promise<unknown> {
    const schema = (PARAM_SCHEMAS as Record<string, typeof PARAM_SCHEMAS.health>)[method];
    if (!schema) throw new ForgeError("InvalidRequest", `unknown method: ${method}`);
    const p = schema.safeParse(params ?? {});
    if (!p.success) throw new ForgeError("InvalidRequest", `invalid params for ${method}: ${p.error.message}`);
    const args = p.data as Record<string, unknown>;
    const { sessions, runtime, registry, store } = this.app;
    const abort = signal ?? new AbortController().signal;

    switch (method as RpcMethod) {
      case "health":
        return { ok: true, version: VERSION, protocol: PROTOCOL_VERSION, uptimeMs: Date.now() - this.startedAt };
      case "create_session":
        return sessions.createSession(args as unknown as import("./session.ts").CreateSessionOpts);
      case "get_session":
        return sessions.getSession(args.sessionId as SessionId);
      case "list_sessions":
        return { sessions: sessions.listSessions((args.limit as number | undefined) ?? 50, (args.offset as number | undefined) ?? 0) };
      case "resume_session": {
        const snapshot = sessions.resumeSession(args.sessionId as SessionId);
        const events = store.listEvents(args.sessionId as SessionId, (args.afterSeq as number | undefined) ?? 0);
        return { snapshot, events };
      }
      case "send_message":
        return sessions.sendMessage(args.sessionId as SessionId, args.content as string, args.agentId as AgentId | undefined);
      case "get_agent":
        return sessions.getAgent(args.agentId as AgentId);
      case "get_session_state": {
        const snapshot = sessions.snapshot(args.sessionId as SessionId);
        const events = store.listEvents(args.sessionId as SessionId, (args.afterSeq as number | undefined) ?? 0);
        return { snapshot, events };
      }
      case "read_file":
      case "write_file":
      case "edit_file":
      case "list_directory":
      case "search_files":
      case "execute_shell":
      case "git_status":
      case "git_diff":
      case "git_log": {
        const { sessionId, ...input } = args as { sessionId: SessionId };
        const toolCtx = sessions.toolContextFor(sessionId);
        return registry.execute(toolCtx, method, input, abort);
      }
      case "run_test":
      case "run_build": {
        const { sessionId, ...input } = args as { sessionId: SessionId };
        const toolCtx = sessions.toolContextFor(sessionId);
        return registry.execute(toolCtx, method === "run_test" ? "run_tests" : "run_build", input, abort);
      }
      case "stream_events":
        if (transport === "http") {
          throw new ForgeError("ProtocolFailure", "stream_events requires the websocket transport (connect to /ws and send stream_events)");
        }
        return { subscribed: true }; // unreachable: ws path handles subscriptions inline
      case "cancel_agent":
        return sessions.cancelAgent(args.agentId as AgentId, args.reason as string | undefined);
      case "resolve_approval": {
        const ok = runtime.resolveApproval(args.approvalId as string, args.approved as boolean);
        const rec = store.getApproval(args.approvalId as string);
        if (rec && rec.status === "pending") {
          store.saveApproval({ ...rec, status: (args.approved as boolean) ? "approved" : "denied", resolvedAt: new Date().toISOString() });
        }
        return { resolved: ok };
      }
      default:
        throw new ForgeError("InvalidRequest", `unimplemented method: ${method}`);
    }
  }
}

import type { SessionManager } from "./session.ts";

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new ForgeError("InvalidRequest", "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
