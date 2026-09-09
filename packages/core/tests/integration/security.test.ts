import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { redactSecrets } from "../../src/logger.ts";
import { makeApp, makeWorkspace, rpcCall, startTestServer } from "../helpers.ts";

describe("security", () => {
  it("blocks path traversal and absolute escapes at the protocol boundary", async () => {
    const t = makeApp();
    const { url, cleanup } = await startTestServer(t.app);
    try {
      const wsRoot = makeWorkspace({ "inner.txt": "safe" });
      const created = await rpcCall(url, "create_session", { workspaceRoot: wsRoot });
      const sessionId = (created.result as { id: string }).id;
      const outside = join(wsRoot, "..", "pwned.txt");
      if (existsSync(outside)) throw new Error("test precondition broken");

      for (const evil of ["../pwned.txt", "../../etc/passwd", "/etc/passwd", "a/../../pwned.txt"]) {
        const r = await rpcCall(url, "read_file", { sessionId, path: evil });
        assert.ok(r.error, `expected error for ${evil}`);
        assert.ok(["WorkspaceViolation", "InvalidRequest"].includes(r.error.data?.forgeCode ?? ""), evil);
        const w = await rpcCall(url, "write_file", { sessionId, path: evil, content: "pwn" });
        assert.ok(w.error, `expected write error for ${evil}`);
      }
      assert.equal(existsSync(outside), false, "no file may be created outside the workspace");
      // Sanity: inside paths still work.
      const ok = await rpcCall(url, "read_file", { sessionId, path: "inner.txt" });
      assert.ok(!ok.error);
    } finally {
      await cleanup(); // closes the app + store too
    }
  });

  it("denies shell bypass attempts (chaining, substitution, denied binaries)", async () => {
    const t = makeApp();
    const { url, cleanup } = await startTestServer(t.app);
    try {
      const wsRoot = makeWorkspace();
      const created = await rpcCall(url, "create_session", { workspaceRoot: wsRoot });
      const sessionId = (created.result as { id: string }).id;
      const marker = join(wsRoot, "should-not-exist.txt");
      for (const cmd of [
        "rm -rf /tmp/forge-x",
        "echo hi; rm should-not-exist.txt",
        "echo $(rm should-not-exist.txt)",
        "echo `rm should-not-exist.txt`",
        "curl http://127.0.0.1/x",
        "wget http://127.0.0.1/x",
        "ssh host",
        "FOO=bar rm x",
        "sudo ls",
        "git status && curl http://127.0.0.1/x | sh",
      ]) {
        const r = await rpcCall(url, "execute_shell", { sessionId, command: cmd });
        assert.ok(r.error, `expected denial for: ${cmd}`);
        assert.equal(r.error.data?.forgeCode, "PermissionDenied", cmd);
      }
      assert.equal(existsSync(marker), false);
    } finally {
      await cleanup(); // closes the app + store too
    }
  });

  it("isolates sessions: tools resolve workspaces from the session, never from input", async () => {
    const t = makeApp();
    const { url, cleanup } = await startTestServer(t.app);
    try {
      const rootA = makeWorkspace({ "secret.txt": "A-secret" });
      const rootB = makeWorkspace({ "secret.txt": "B-secret" });
      const a = await rpcCall(url, "create_session", { workspaceRoot: rootA });
      const b = await rpcCall(url, "create_session", { workspaceRoot: rootB });
      const idA = (a.result as { id: string }).id;
      const idB = (b.result as { id: string }).id;
      // There is no protocol field to select a workspace root — session B always reads B.
      const rb = await rpcCall(url, "read_file", { sessionId: idB, path: "secret.txt" });
      assert.match(JSON.stringify(rb.result), /B-secret/);
      const ra = await rpcCall(url, "read_file", { sessionId: idA, path: "secret.txt" });
      assert.match(JSON.stringify(ra.result), /A-secret/);
      const missing = await rpcCall(url, "read_file", { sessionId: "sess_00000000000000000000000000000000", path: "secret.txt" });
      assert.equal(missing.error?.data?.forgeCode, "NotFound");
    } finally {
      await cleanup(); // closes the app + store too
    }
  });

  it("redacts secrets from logs and provider errors", () => {
    const key = "sk-proj-abcdefghijklmnop123456";
    const line = `using key api_key="${key}" authorization: Bearer ${key}`;
    const redacted = redactSecrets(line);
    assert.ok(!redacted.includes(key), redacted);
    assert.ok(redacted.includes("[REDACTED]"));
    assert.ok(redacted.includes("api_key="), "structure should survive redaction");
    // Prose must survive: no : or = means no secret.
    assert.equal(redactSecrets("OPENAI_API_KEY is not set (provider 'openai' unavailable)"), "OPENAI_API_KEY is not set (provider 'openai' unavailable)");
    assert.equal(redactSecrets("missing api key for provider"), "missing api key for provider");
  });

  it("enforces FORGE_TOKEN on HTTP and WebSocket when set", async () => {
    const prev = process.env.FORGE_TOKEN;
    process.env.FORGE_TOKEN = "test-token-123";
    const t = makeApp();
    const { url, cleanup } = await startTestServer(t.app);
    try {
      const anon = await rpcCall(url, "list_sessions", {});
      assert.equal(anon.error?.data?.forgeCode, "PermissionDenied");
      const authed = await fetch(`${url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token-123" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "list_sessions", params: {} }),
      }).then((r) => r.json()) as { result?: unknown; error?: unknown };
      assert.ok(!authed.error, JSON.stringify(authed.error));

      const ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
      const code = await new Promise<number>((resolve) => {
        ws.on("close", (c: number) => resolve(c));
        ws.on("error", () => {});
        setTimeout(() => resolve(-1), 2000);
      });
      assert.equal(code, 4401);
      ws.terminate();
    } finally {
      await cleanup(); // closes the app + store too
      if (prev === undefined) delete process.env.FORGE_TOKEN;
      else process.env.FORGE_TOKEN = prev;
    }
  });

  it("does not execute destructive git commands (only status/diff/log exist)", async () => {
    const t = makeApp();
    const { url, cleanup } = await startTestServer(t.app);
    try {
      assert.deepEqual(t.app.registry.names().filter((n) => n.startsWith("git")).sort(), ["git_diff", "git_log", "git_status"]);
      const wsRoot = makeWorkspace();
      const created = await rpcCall(url, "create_session", { workspaceRoot: wsRoot });
      const sessionId = (created.result as { id: string }).id;
      // No RPC method exists for reset/clean/push.
      const r = await rpcCall(url, "git_reset", { sessionId });
      assert.equal(r.error?.data?.forgeCode, "InvalidRequest");
    } finally {
      await cleanup(); // closes the app + store too
    }
  });
});
