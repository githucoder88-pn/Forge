import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { makeApp, makeWorkspace, rpcCall, startTestServer, tempDir } from "../helpers.ts";

describe("performance bounds", () => {
  it("caps large file reads instead of loading everything", async () => {
    const t = makeApp();
    try {
      const root = makeWorkspace();
      writeFileSync(join(root, "big.txt"), "0123456789abcdef\n".repeat(200_000)); // ~3.4MB
      const session = t.app.sessions.createSession({ workspaceRoot: root });
      const toolCtx = t.app.sessions.toolContextFor(session.id);
      const t0 = Date.now();
      const res = await t.app.registry.execute(toolCtx, "read_file", { path: "big.txt" }, new AbortController().signal);
      const dt = Date.now() - t0;
      assert.equal(res.ok, true);
      const r = res.result as { truncated: boolean; content: string; bytes: number };
      assert.equal(r.truncated, true);
      assert.ok(r.content.length <= t.app.config.limits.maxFileBytes + 100, `content=${r.content.length}`);
      assert.ok(dt < 5000, `read took ${dt}ms`);
    } finally {
      t.cleanup();
    }
  });

  it("caps large shell output while keeping the exit code", async () => {
    const t = makeApp();
    try {
      const session = t.app.sessions.createSession({ workspaceRoot: makeWorkspace() });
      const toolCtx = t.app.sessions.toolContextFor(session.id);
      const res = await t.app.registry.execute(
        toolCtx,
        "execute_shell",
        { command: "node -e \"for(let i=0;i<200;i++) console.log('x'.repeat(5000))\"" },
        new AbortController().signal,
      );
      assert.equal(res.ok, true);
      const r = res.result as { truncated: boolean; exitCode: number; stdout: string };
      assert.equal(r.exitCode, 0);
      assert.equal(r.truncated, true);
      assert.ok(r.stdout.length <= 20_000, `stdout=${r.stdout.length}`);
    } finally {
      t.cleanup();
    }
  });

  it("searches a wide repo with bounded results and time", async () => {
    const t = makeApp();
    try {
      const root = tempDir("forge-perf-repo-");
      for (let d = 0; d < 20; d++) {
        const dir = join(root, `pkg${d}`);
        mkdirSync(dir, { recursive: true });
        for (let f = 0; f < 100; f++) {
          writeFileSync(join(dir, `file${f}.txt`), `needle-${d} line\nfiller content ${f}\n`);
        }
      }
      mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(root, "node_modules", "dep", "x.js"), "needle should be skipped here\n");
      const session = t.app.sessions.createSession({ workspaceRoot: root });
      const toolCtx = t.app.sessions.toolContextFor(session.id);
      const t0 = Date.now();
      const res = await t.app.registry.execute(toolCtx, "search_files", { query: "needle", maxResults: 50 }, new AbortController().signal);
      const dt = Date.now() - t0;
      assert.equal(res.ok, true);
      const r = res.result as { matches: { path: string }[]; filesScanned: number };
      assert.equal(r.matches.length, 50);
      assert.ok(!r.matches.some((m) => m.path.includes("node_modules")), "ignore patterns must apply");
      assert.ok(dt < 25_000, `search took ${dt}ms`);
    } finally {
      t.cleanup();
    }
  });

  it("fans out to many concurrent websocket subscribers", async () => {
    const t = makeApp();
    const { url, cleanup } = await startTestServer(t.app);
    try {
      const created = await rpcCall(url, "create_session", { workspaceRoot: makeWorkspace() });
      const sessionId = (created.result as { id: string }).id;
      const N = 15;
      const counts = new Array(N).fill(0);
      const sockets: WebSocket[] = [];
      await Promise.all(
        Array.from({ length: N }, (_, i) => new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
          sockets.push(ws);
          ws.on("open", () => {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method: "stream_events", params: { sessionId } }));
            setTimeout(resolve, 150);
          });
          ws.on("message", (data) => {
            const m = JSON.parse(String(data)) as { method?: string };
            if (m.method === "event") counts[i]++;
          });
          ws.on("error", reject);
        })),
      );
      await rpcCall(url, "write_file", { sessionId, path: "fan.txt", content: "out" });
      await new Promise((r) => setTimeout(r, 800));
      for (const ws of sockets) ws.close();
      assert.ok(counts.every((c) => c >= 3), `subscriber counts: ${counts.join(",")}`);
    } finally {
      await cleanup(); // closes the app + store too
    }
  });
});
