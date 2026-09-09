/**
 * ForgeServer: HTTP JSON-RPC API (POST /rpc), live events (WS /ws, SSE
 * /events), static clients (/app, /client) and token auth. Binds loopback
 * by default; non-loopback bind requires the auth token.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { EventBus, ForgeEvent, ForgeRuntime, globalConfigDir, matches } from '@forge/core';
import { PROTOCOL_VERSION, RPC_ERROR, failure, type EventNotification, type JsonRpcRequest } from '@forge/protocol';
import { dispatch } from './dispatch.js';

export interface ServerOptions {
  runtime: ForgeRuntime;
  port?: number;
  host?: string;
  /** Pre-shared token. Defaults to the token file (created on first boot). */
  token?: string;
  /** Force auth even on loopback. */
  requireAuth?: boolean;
  /** Static dir for the web client (/app). */
  webDir?: string;
  /** Compiled protocol-client dir (/client). */
  clientDistDir?: string;
}

export const DEFAULT_PORT = 8719;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

export function tokenFilePath(): string {
  return join(globalConfigDir(), 'token');
}

/** Load or create the server auth token (0600). Never logged. */
export function ensureToken(explicit?: string): { token: string; created: boolean } {
  if (explicit) return { token: explicit, created: false };
  const path = tokenFilePath();
  if (existsSync(path)) return { token: readFileSync(path, 'utf8').trim(), created: false };
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  return { token, created: true };
}

function isLoopback(remoteAddress?: string): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

function readBody(req: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface WsClient {
  ws: WebSocket;
  filter: { types?: string[]; sessionId?: string; agentId?: string; taskId?: string; teamId?: string };
}

export class ForgeServer {
  readonly runtime: ForgeRuntime;
  readonly port: number;
  readonly host: string;
  readonly token: string;
  readonly tokenCreated: boolean;
  private server: Server;
  private wss: WebSocketServer;
  private clients = new Set<WsClient>();
  private sseClients = new Set<ServerResponse>();
  private unsub?: () => void;
  private startedAt = 0;
  private webDir?: string;
  private clientDistDir?: string;
  private requireAuth: boolean;

  constructor(opts: ServerOptions) {
    this.runtime = opts.runtime;
    this.port = opts.port ?? DEFAULT_PORT;
    this.host = opts.host ?? '127.0.0.1';
    const { token, created } = ensureToken(opts.token ?? process.env.FORGE_TOKEN);
    this.token = token;
    this.tokenCreated = created;
    this.webDir = opts.webDir;
    this.clientDistDir = opts.clientDistDir;
    this.requireAuth = opts.requireAuth ?? process.env.FORGE_REQUIRE_AUTH === '1';

    const loopbackHost = this.host === '127.0.0.1' || this.host === 'localhost' || this.host === '::1';
    if (!loopbackHost && !this.token) {
      throw new Error('Refusing to bind a non-loopback address without an auth token');
    }

    this.server = createServer((req, res) => {
      this.route(req, res).catch((e) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify(failure(null, RPC_ERROR.INTERNAL, (e as Error).message)));
        }
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      if (!this.authorized(req, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.addWs(ws));
    });
  }

  get bus(): EventBus {
    return this.runtime.bus;
  }

  async start(): Promise<{ url: string }> {
    this.startedAt = Date.now();
    this.unsub = this.bus.subscribe(() => true, (e) => this.broadcast(e));
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolvePromise();
      });
    });
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.port;
    return { url: `http://${this.host}:${port}` };
  }

  async stop(): Promise<void> {
    this.unsub?.();
    for (const c of this.clients) {
      try { c.ws.close(); } catch { /* ignore */ }
    }
    for (const res of this.sseClients) {
      try { res.end(); } catch { /* ignore */ }
    }
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  address(): string {
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.port;
    return `http://${this.host}:${port}`;
  }

  // ------------------------------------------------------------------ http ---

  private authorized(req: IncomingMessage, url?: URL): boolean {
    if (!this.requireAuth && isLoopback(req.socket.remoteAddress)) return true;
    const header = req.headers.authorization;
    const queryToken = url?.searchParams.get('token');
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : queryToken;
    return !!presented && presented === this.token;
  }

  private cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const host = new URL(origin).hostname;
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        }
      } catch { /* invalid origin — no CORS */ }
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    this.cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, protocol: PROTOCOL_VERSION, uptimeMs: Date.now() - this.startedAt,
        projectDir: this.runtime.projectDir, eventSeq: this.bus.latestSeq(),
      }));
      return;
    }

    if (url.pathname === '/rpc' && req.method === 'POST') {
      if (!this.authorized(req, url)) return this.unauthorized(res);
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failure(null, RPC_ERROR.PARSE, 'Invalid JSON')));
        return;
      }
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      if (batch.length > 100) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failure(null, RPC_ERROR.INVALID_REQUEST, 'Batch too large (max 100)')));
        return;
      }
      const out = [];
      for (const item of batch) {
        out.push(await dispatch(item as JsonRpcRequest, { runtime: this.runtime }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
      return;
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      if (!this.authorized(req, url)) return this.unauthorized(res);
      await this.serveSse(req, res, url);
      return;
    }

    if (url.pathname === '/app' || url.pathname === '/app/') {
      return this.serveStatic(res, this.webDir, '/index.html');
    }
    if (url.pathname.startsWith('/app/')) {
      if (!this.authorized(req, url)) return this.unauthorized(res);
      return this.serveStatic(res, this.webDir, url.pathname.slice(4));
    }
    if (url.pathname.startsWith('/client/')) {
      if (!this.authorized(req, url)) return this.unauthorized(res);
      return this.serveStatic(res, this.clientDistDir, url.pathname.slice(7));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found', hint: 'POST /rpc, GET /events, WS /ws, GET /app/' }));
  }

  private unauthorized(res: ServerResponse): void {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized', hint: 'Provide Authorization: Bearer <token>' }));
  }

  private serveStatic(res: ServerResponse, baseDir: string | undefined, relPath: string): void {
    if (!baseDir) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'client not built', hint: 'Build the web client first' }));
      return;
    }
    const root = resolve(baseDir);
    const abs = resolve(root, '.' + relPath);
    if (abs !== root && !abs.startsWith(root + '/')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
      return;
    }
    let file = abs;
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) throw new Error('missing');
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }
  }

  // ---------------------------------------------------------------- events ---

  private async serveSse(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? 0);
    const types = url.searchParams.get('types')?.split(',').filter(Boolean);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`: forge ${PROTOCOL_VERSION}\n\n`);
    // Replay missed history first (ordered), then stream live.
    try {
      const missed = this.runtime.store.loadEvents({ sessionId, sinceSeq, types, limit: 1000 });
      for (const e of missed) res.write(`data: ${JSON.stringify(toNotification(e))}\n\n`);
    } catch { /* serve live-only */ }
    const filter = { sessionId, types };
    const handler = (e: ForgeEvent): void => {
      if (filter.sessionId && e.sessionId !== filter.sessionId) return;
      if (filter.types && !filter.types.includes(e.type)) return;
      try {
        res.write(`data: ${JSON.stringify(toNotification(e))}\n\n`);
      } catch { /* client gone */ }
    };
    const unsub = this.bus.subscribe(() => true, handler);
    this.sseClients.add(res);
    const keepalive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 20_000);
    res.on('close', () => {
      clearInterval(keepalive);
      unsub();
      this.sseClients.delete(res);
    });
  }

  private addWs(ws: WebSocket): void {
    const client: WsClient = { ws, filter: {} };
    this.clients.add(client);
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ready', params: { protocol: PROTOCOL_VERSION, sinceSeq: this.bus.latestSeq() } }));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; filter?: WsClient['filter']; sinceSeq?: number };
        if (msg.type === 'subscribe' && msg.filter) client.filter = msg.filter;
        if (msg.type === 'replay') {
          const missed = this.runtime.store.loadEvents({
            sessionId: client.filter.sessionId,
            sinceSeq: msg.sinceSeq ?? 0,
            types: client.filter.types,
            limit: 1000,
          });
          for (const e of missed) ws.send(JSON.stringify(toNotification(e)));
        }
      } catch { /* ignore malformed messages */ }
    });
    ws.on('close', () => { this.clients.delete(client); });
    ws.on('error', () => { this.clients.delete(client); });
  }

  private broadcast(e: ForgeEvent): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(toNotification(e));
    for (const c of this.clients) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      const f = c.filter;
      if (f.types && !f.types.includes(e.type)) continue;
      if (f.sessionId && e.sessionId !== f.sessionId) continue;
      if (f.agentId && e.agentId !== f.agentId) continue;
      if (f.taskId && e.taskId !== f.taskId) continue;
      if (f.teamId && e.teamId !== f.teamId) continue;
      try { c.ws.send(payload); } catch { /* ignore */ }
    }
    void matches;
  }
}

export function toNotification(e: ForgeEvent): EventNotification {
  return {
    jsonrpc: '2.0',
    method: 'event',
    params: {
      id: e.id, seq: e.seq, v: 1, ts: e.ts, type: e.type,
      sessionId: e.sessionId, agentId: e.agentId, taskId: e.taskId, teamId: e.teamId,
      simulated: e.simulated || undefined, data: e.data,
    },
  };
}
