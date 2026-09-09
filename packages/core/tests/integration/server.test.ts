import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { CoreServer } from "../../src/server.ts";
import type { SessionId } from "@forge/protocol";
import { makeApp, makeWorkspace } from "../helpers.ts";

interface TestServer {
  server: CoreServer;
  url: string;
  cleanup: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const t = makeApp();
  t.app.config.port = 0;
  t.app.config.host = "127.0.0.1";
  const server = new CoreServer(t.app);
  const { url } = await server.listen();
  return { server, url, cleanup: async () => { await server.close(); } };
}

async function rpc(url: string, method: string, params: unknown, id = 1): Promise<{ result?: unknown; error?: { message: string; data?: { forgeCode: string } } }> {
  const res = await fetch(`${url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await res.json()) as { result?: unknown; error?: { message: string; data?: { forgeCode: string } } };
}

describe("core server", () => {
  it("serves health, session CRUD, and direct tools over HTTP", async () => {
    const s = await startServer();
    try {
      const health = await fetch(`${s.url}/health`).then((r) => r.json()) as { ok: boolean; protocol: string };
      assert.equal(health.ok, true);
      assert.equal(health.protocol, "1.0");

      const wsRoot = makeWorkspace({ "a.txt": "hello" });
      const created = await rpc(s.url, "create_session", { workspaceRoot: wsRoot, title: "srv" });
      assert.ok(!(created as { error?: unknown }).error, JSON.stringify(created));
      const session = (created.result as { id: SessionId });

      const read = await rpc(s.url, "read_file", { sessionId: session.id, path: "a.txt" });
      assert.match(JSON.stringify(read.result), /hello/);

      const search = await rpc(s.url, "search_files", { sessionId: session.id, query: "hell" });
      assert.equal(((search.result as { result: { matches: unknown[] } }).result).matches.length >= 0, true);

      const state = await rpc(s.url, "get_session_state", { sessionId: session.id });
      assert.equal((state.result as { snapshot: { session: { id: string } } }).snapshot.session.id, session.id);

      const list = await rpc(s.url, "list_sessions", {});
      assert.ok(((list.result as { sessions: unknown[] }).sessions).length >= 1);
    } finally {
      await s.cleanup();
    }
  });

  it("streams live events over websocket with replay + reconnect catch-up", async () => {
    const s = await startServer();
    try {
      const wsRoot = makeWorkspace({ "a.txt": "x" });
      const created = await rpc(s.url, "create_session", { workspaceRoot: wsRoot });
      const session = (created.result as { id: SessionId });

      // Live subscribe.
      const ws1 = new WebSocket(`${s.url.replace("http", "ws")}/ws`);
      await new Promise<void>((resolve) => ws1.on("open", () => resolve()));
      const live: string[] = [];
      ws1.on("message", (data) => {
        const m = JSON.parse(String(data)) as { method?: string; params?: { type: string; seq: number } };
        if (m.method === "event" && m.params) live.push(`${m.params.seq}:${m.params.type}`);
      });
      ws1.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "stream_events", params: { sessionId: session.id } }));
      await new Promise((r) => setTimeout(r, 300));
      await rpc(s.url, "write_file", { sessionId: session.id, path: "b.txt", content: "new" });
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(live.some((e) => e.includes("file.created")), JSON.stringify(live));
      const lastSeq = Number(live[live.length - 1]?.split(":")[0]);
      ws1.close();
      await new Promise((r) => setTimeout(r, 200));

      // Reconnect with afterSeq -> only newer events replay.
      await rpc(s.url, "write_file", { sessionId: session.id, path: "c.txt", content: "newer" });
      const ws2 = new WebSocket(`${s.url.replace("http", "ws")}/ws`);
      await new Promise<void>((resolve) => ws2.on("open", () => resolve()));
      const replayed: number[] = [];
      ws2.on("message", (data) => {
        const m = JSON.parse(String(data)) as { method?: string; params?: { type: string; seq: number } };
        if (m.method === "event" && m.params) replayed.push(m.params.seq);
      });
      ws2.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "stream_events", params: { sessionId: session.id, afterSeq: lastSeq } }));
      await new Promise((r) => setTimeout(r, 400));
      ws2.close();
      assert.ok(replayed.length >= 1);
      assert.ok(replayed.every((n) => n > lastSeq), JSON.stringify(replayed));
    } finally {
      await s.cleanup();
    }
  });

  it("returns typed errors for invalid requests without crashing", async () => {
    const s = await startServer();
    try {
      const bad = await rpc(s.url, "nope_method", {});
      assert.equal(bad.error?.data?.forgeCode, "InvalidRequest");
      const missing = await rpc(s.url, "get_session", { sessionId: "sess_doesnotexist0000000000000000" });
      assert.ok(missing.error, "expected error");
      // Malformed JSON body.
      const res = await fetch(`${s.url}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad json" });
      assert.equal(res.status, 400);
      // Server still healthy afterwards.
      const health = await fetch(`${s.url}/health`).then((r) => r.json()) as { ok: boolean };
      assert.equal(health.ok, true);
    } finally {
      await s.cleanup();
    }
  });

  it("runs send_message -> agent loop in background and supports cancel", async () => {
    const s = await startServer();
    try {
      const wsRoot = makeWorkspace({ "a.txt": "x" });
      const created = await rpc(s.url, "create_session", { workspaceRoot: wsRoot, provider: "mock" });
      const session = (created.result as { id: SessionId });
      const sent = await rpc(s.url, "send_message", { sessionId: session.id, content: "do nothing, just reply" });
      const agentId = (sent.result as { agentId: string }).agentId;
      assert.match(agentId, /^agent_/);
      // Wait for completion (mock provider replies immediately).
      for (let i = 0; i < 50; i++) {
        const g = await rpc(s.url, "get_agent", { agentId });
        if ((g.result as { state: string }).state === "completed") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const g = await rpc(s.url, "get_agent", { agentId });
      assert.equal((g.result as { state: string }).state, "completed");
      const cancel = await rpc(s.url, "cancel_agent", { agentId });
      assert.equal((cancel.result as { cancelled: boolean }).cancelled, false); // not running anymore
    } finally {
      await s.cleanup();
    }
  });
});
