import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForgeError, createProviderId, type AgentId, type SessionId } from "@forge/protocol";
import { createApp } from "../../src/app.ts";
import type { ModelProvider, ModelRequest, StreamEvent } from "../../src/models.ts";
import { makeApp, makeWorkspace, rpcCall, startTestServer, tempDir } from "../helpers.ts";

/** Provider double that always fails like an unreachable upstream. */
function failingProvider(): ModelProvider {
  return {
    name: "failing",
    providerId: createProviderId(),
    capabilities: () => ({ toolCalling: true, streaming: true, vision: false, maxContextTokens: 1000 }),
    complete: async () => {
      throw new ForgeError("ProviderUnavailable", "upstream exploded");
    },
  };
}

describe("failure recovery", () => {
  it("provider failure fails the agent cleanly without crashing core", async () => {
    const dataDir = tempDir("forge-fail-");
    const app = createApp({ dataDir, dbFilename: "fail.db", autoApprove: true, logLevel: "error", getProvider: failingProvider });
    const { url, cleanup } = await startTestServer(app);
    try {
      const created = await rpcCall(url, "create_session", { workspaceRoot: makeWorkspace(), provider: "mock" });
      const sessionId = (created.result as { id: SessionId }).id;
      const sent = await rpcCall(url, "send_message", { sessionId, content: "doomed" });
      const agentId = (sent.result as { agentId: AgentId }).agentId;
      let state = "";
      for (let i = 0; i < 40; i++) {
        const g = await rpcCall(url, "get_agent", { agentId });
        state = (g.result as { state: string }).state;
        if (state === "failed") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(state, "failed");
      const agent = await rpcCall(url, "get_agent", { agentId });
      assert.match(JSON.stringify(agent.result), /upstream exploded/);
      // Core still serves other sessions.
      const health = await fetch(`${url}/health`).then((r) => r.json()) as { ok: boolean };
      assert.equal(health.ok, true);
    } finally {
      await cleanup();
    }
  });

  it("tool timeout becomes a result the agent can observe (loop survives)", async () => {
    const steps = [
      { text: "slow command", toolCalls: [{ tool: "execute_shell", input: { command: "node -e \"setTimeout(()=>{}, 5000)\"", timeoutMs: 200 } }] },
      { text: "It timed out; finishing without changes." },
    ];
    const t = makeApp(steps);
    const { url, cleanup } = await startTestServer(t.app);
    try {
      const created = await rpcCall(url, "create_session", { workspaceRoot: makeWorkspace(), provider: "mock" });
      const sessionId = (created.result as { id: SessionId }).id;
      const sent = await rpcCall(url, "send_message", { sessionId, content: "try slow cmd" });
      const agentId = (sent.result as { agentId: AgentId }).agentId;
      let state = "";
      for (let i = 0; i < 60; i++) {
        const g = await rpcCall(url, "get_agent", { agentId });
        state = (g.result as { state: string }).state;
        if (state === "completed" || state === "failed") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(state, "completed");
      const { events } = await rpcCall(url, "get_session_state", { sessionId }).then((r) => r.result as { events: { type: string }[] });
      assert.ok(events.some((e) => e.type === "tool.failed"), "timeout should surface as tool.failed");
    } finally {
      await cleanup(); // closes the app + store too
    }
  });

  it("approval gates pause tool execution until resolved via RPC", async () => {
    const dataDir = tempDir("forge-appr-");
    const app = createApp({ dataDir, dbFilename: "appr.db", autoApprove: false, logLevel: "error" });
    try {
      const session = app.sessions.createSession({
        workspaceRoot: makeWorkspace({ "victim.txt": "x" }),
        permissions: { mode: "workspace-write", approval: "risky-only" },
      });
      const toolCtx = app.sessions.toolContextFor(session.id);
      let approvalId = "";
      const unsub = app.bus.subscribe(session.id, (e) => {
        if (e.type === "approval.requested") approvalId = (e.payload as { approvalId: string }).approvalId;
      });
      const p = app.registry.execute(toolCtx, "delete_file", { path: "victim.txt" }, new AbortController().signal);
      // Wait for the gate to engage, then approve through the runtime (as the RPC would).
      for (let i = 0; i < 50 && !approvalId; i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(approvalId, "approval.requested should fire for destructive tools");
      // Deny first on a second call? No — approve this one and verify execution.
      assert.equal(app.runtime.resolveApproval(approvalId, true), true);
      const res = await p;
      unsub();
      assert.equal(res.ok, true);
      const rec = app.store.getApproval(approvalId);
      assert.equal(rec?.status, "approved");
    } finally {
      app.close();
    }
  });

  it("resolve_approval works end to end over RPC", async () => {
    const dataDir = tempDir("forge-appr-rpc-");
    const app = createApp({ dataDir, dbFilename: "appr-rpc.db", autoApprove: false, logLevel: "error" });
    const { url, cleanup } = await startTestServer(app);
    try {
      const created = await rpcCall(url, "create_session", { workspaceRoot: makeWorkspace({ "v.txt": "x" }) });
      const sessionId = (created.result as { id: SessionId }).id;
      // Start the gated tool call in the background (do not await yet).
      const pending = rpcCall(url, "execute_shell", { sessionId, command: "terraform plan" });
      // Wait for the approval gate to engage.
      let approvalId = "";
      for (let i = 0; i < 50 && !approvalId; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const st = await rpcCall(url, "get_session_state", { sessionId });
        const ev = ((st.result as { events: { type: string; payload: { approvalId?: string } }[] }).events).find((e) => e.type === "approval.requested");
        if (ev?.payload.approvalId) approvalId = ev.payload.approvalId;
      }
      assert.ok(approvalId, "approval.requested should be persisted for unknown binaries");
      const resolved = await rpcCall(url, "resolve_approval", { approvalId, approved: false });
      assert.equal((resolved.result as { resolved: boolean }).resolved, true);
      const toolRes = await pending;
      assert.equal(toolRes.error?.data?.forgeCode, "PermissionDenied");
    } finally {
      await cleanup();
    }
  });

  it("denied approvals reject the tool with PermissionDenied", async () => {
    const dataDir = tempDir("forge-deny-");
    const app = createApp({ dataDir, dbFilename: "deny.db", autoApprove: false, logLevel: "error" });
    try {
      const session = app.sessions.createSession({ workspaceRoot: makeWorkspace({ "v.txt": "x" }) });
      const toolCtx = app.sessions.toolContextFor(session.id);
      let approvalId = "";
      const unsub = app.bus.subscribe(session.id, (e) => {
        if (e.type === "approval.requested") approvalId = (e.payload as { approvalId: string }).approvalId;
      });
      const p = app.registry.execute(toolCtx, "delete_file", { path: "v.txt" }, new AbortController().signal);
      for (let i = 0; i < 50 && !approvalId; i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(approvalId);
      assert.equal(app.runtime.resolveApproval(approvalId, false), true);
      await assert.rejects(() => p, (e: unknown) => e instanceof ForgeError && e.code === "PermissionDenied");
      unsub();
    } finally {
      app.close();
    }
  });

  it("unknown approval ids resolve idempotently without throwing", async () => {
    const t = makeApp();
    try {
      assert.equal(t.app.runtime.resolveApproval("appr_doesnotexist00000000000000", true), false);
    } finally {
      t.cleanup();
    }
  });

  it("concurrent send_message on a running agent returns Conflict, not a second loop", async () => {
    const slow: ModelProvider = {
      name: "slow",
      providerId: createProviderId(),
      capabilities: () => ({ toolCalling: true, streaming: true, vision: false, maxContextTokens: 1000 }),
      complete: async (req: ModelRequest, onEvent: (e: StreamEvent) => void) => {
        await new Promise((r) => setTimeout(r, 1500));
        if (req.signal.aborted) throw new ForgeError("Cancelled", "x");
        onEvent({ kind: "text", delta: "done" });
        return { text: "done", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const dataDir = tempDir("forge-conflict-");
    const app = createApp({ dataDir, dbFilename: "c.db", autoApprove: true, logLevel: "error", getProvider: () => slow });
    const { url, cleanup } = await startTestServer(app);
    try {
      const created = await rpcCall(url, "create_session", { workspaceRoot: makeWorkspace(), provider: "mock" });
      const sessionId = (created.result as { id: SessionId }).id;
      const first = await rpcCall(url, "send_message", { sessionId, content: "one" });
      assert.ok(!first.error);
      const second = await rpcCall(url, "send_message", { sessionId, content: "two" });
      assert.equal(second.error?.data?.forgeCode, "Conflict");
      await rpcCall(url, "cancel_agent", { agentId: (first.result as { agentId: string }).agentId });
    } finally {
      await cleanup();
    }
  });
});
