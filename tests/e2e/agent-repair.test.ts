/**
 * Phase-1 acceptance E2E: a real agent repairs the failing fixture test through
 * the full stack (protocol -> session -> agent loop -> tools -> events -> disk).
 *
 * The ONLY test double is the model itself (GreedyRepairProvider below): it stands
 * in for the LLM with a small reactive policy driven by REAL tool outputs. All
 * other layers — server, session, loop, tools, events, persistence — are real.
 * The live-model path is covered by the OpenAI adapter tests + `forge run`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createProviderId, ForgeError, type AgentId, type SessionId } from "@forge/protocol";
import { createApp } from "../../packages/core/src/app.ts";
import type { ModelProvider, ModelRequest, ModelResponse, StreamEvent } from "../../packages/core/src/models.ts";
import { rpcCall, startTestServer, tempDir } from "../../packages/core/tests/helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = join(here, "..", "fixtures", "fixture-project");

function lastToolOutput(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === "tool") return m.content;
  }
  return "";
}

/**
 * Reactive model double: inspects -> tests -> fixes (from the actual failure
 * output) -> re-tests -> summarizes. Decisions branch on real tool results.
 */
class GreedyRepairProvider implements ModelProvider {
  readonly name = "greedy-repair";
  readonly providerId = createProviderId();
  calls = 0;
  capabilities(_model: string) {
    return { toolCalling: true, streaming: true, vision: false, maxContextTokens: 128_000 };
  }
  async complete(req: ModelRequest, onEvent: (e: StreamEvent) => void): Promise<ModelResponse> {
    this.calls++;
    if (req.signal.aborted) throw new ForgeError("Cancelled", "cancelled");
    const out = lastToolOutput(req);
    const step = (text: string, toolCalls: { tool: string; input: unknown }[] = []): ModelResponse => {
      onEvent({ kind: "text", delta: text });
      const calls = toolCalls.map((t, i) => ({ id: `greedy_${this.calls}_${i}`, tool: t.tool, input: t.input }));
      for (const c of calls) onEvent({ kind: "toolcall", toolCall: c });
      return { text, toolCalls: calls, finishReason: calls.length ? "tool_calls" : "stop", usage: { inputTokens: 10, outputTokens: 10 } };
    };
    if (this.calls === 1) {
      return step("I'll inspect the project first.", [
        { tool: "read_file", input: { path: "AGENTS.md" } },
        { tool: "read_file", input: { path: "src/calculator.js" } },
        { tool: "read_file", input: { path: "test/run-tests.js" } },
      ]);
    }
    if (this.calls === 2) {
      return step("Running the suite to observe the failure.", [{ tool: "run_tests", input: {} }]);
    }
    if (this.calls === 3) {
      assert.match(out, /AssertionError|should be 10/, "expected a real test failure in tool output");
      return step("The sum drops the last element. Fixing the loop bound.", [
        { tool: "edit_file", input: { path: "src/calculator.js", oldText: "i < numbers.length - 1", newText: "i < numbers.length" } },
      ]);
    }
    if (this.calls === 4) {
      assert.match(out, /success/, "expected the edit to succeed");
      return step("Verifying the fix.", [{ tool: "run_tests", input: {} }]);
    }
    // calls >= 5: terminal — but only claim success when tools proved it.
    if (out.includes('"passed": true') || out.includes("all fixture tests passed")) {
      return step("Fixed: `sum` in src/calculator.js dropped the last element (off-by-one loop bound). Changed `i < numbers.length - 1` to `i < numbers.length`. Verified with `npm test` — all fixture tests passed.");
    }
    return step(`Could not verify the fix. Last output:\n${out.slice(0, 1000)}`);
  }
}

describe("phase-1 acceptance: repair the failing fixture test", () => {
  it("user request -> agent -> model -> read -> edit -> test -> pass -> summary", async () => {
    // Work on a copy — the agent mutates the repo.
    const workdir = join(tempDir("forge-e2e-"), "fixture-project");
    cpSync(FIXTURE_SRC, workdir, { recursive: true });

    const dataDir = tempDir("forge-e2e-data-");
    const app = createApp({
      dataDir,
      dbFilename: "e2e.db",
      autoApprove: true,
      logLevel: "error",
      getProvider: () => new GreedyRepairProvider(),
    });
    const { url, cleanup } = await startTestServer(app);
    try {
      // 1. Open session on the fixture repo.
      const created = await rpcCall(url, "create_session", { workspaceRoot: workdir, title: "e2e repair", provider: "mock" });
      assert.ok(!created.error, JSON.stringify(created.error));
      const sessionId = (created.result as { id: SessionId }).id;

      // 2. Subscribe to the live event stream.
      const ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      const eventTypes: string[] = [];
      ws.on("message", (data) => {
        const m = JSON.parse(String(data)) as { method?: string; params?: { type: string } };
        if (m.method === "event" && m.params) eventTypes.push(m.params.type);
      });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "stream_events", params: { sessionId } }));
      await new Promise((r) => setTimeout(r, 200));

      // 3. The actual coding request.
      const sent = await rpcCall(url, "send_message", { sessionId, content: "Fix the failing test in this repository." });
      assert.ok(!sent.error, JSON.stringify(sent.error));
      const agentId = (sent.result as { agentId: AgentId }).agentId;

      // 4. Wait for the agent to finish.
      let state = "";
      for (let i = 0; i < 120; i++) {
        const g = await rpcCall(url, "get_agent", { agentId });
        state = (g.result as { state: string }).state;
        if (state === "completed" || state === "failed" || state === "cancelled") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(state, "completed");
      await new Promise((r) => setTimeout(r, 300));
      ws.close();

      // 5. The file REALLY changed on disk.
      const fixed = readFileSync(join(workdir, "src", "calculator.js"), "utf8");
      assert.ok(fixed.includes("i < numbers.length"), "loop bound should be fixed");
      assert.ok(!fixed.includes("numbers.length - 1"), "old buggy bound should be gone");

      // 6. The suite REALLY passes now (independent verification, not the agent's word).
      execFileSync("npm", ["test", "--silent"], { cwd: workdir, stdio: "pipe" });

      // 7. The user could observe the whole run as events.
      for (const t of ["agent.started", "model.requested", "tool.started", "file.modified", "test.started", "test.failed", "test.passed", "agent.completed"]) {
        assert.ok(eventTypes.includes(t), `missing event ${t} in [${[...new Set(eventTypes)].join(", ")}]`);
      }

      // 8. Persistence: the finished session is resumable with full history.
      const resumed = await rpcCall(url, "resume_session", { sessionId });
      const snap = (resumed.result as { snapshot: { agents: { id: string; state: string }[]; messages: unknown[] } }).snapshot;
      assert.equal(snap.agents[0]?.state, "completed");
      assert.ok(snap.messages.length >= 3, "conversation should be persisted");
    } finally {
      await cleanup();
    }
  });

  it("cancellation propagates: agent, model, shell, and tools stop cleanly", async () => {
    const dataDir = tempDir("forge-e2e-cancel-");
    const app = createApp({
      dataDir,
      dbFilename: "cancel.db",
      autoApprove: true,
      logLevel: "error",
      getProvider: () =>
        ({
          name: "sleeper",
          providerId: createProviderId(),
          capabilities: () => ({ toolCalling: true, streaming: true, vision: false, maxContextTokens: 1000 }),
          complete: async (req: ModelRequest, onEvent: (e: StreamEvent) => void) => {
            if (req.signal.aborted) throw new ForgeError("Cancelled", "cancelled");
            const text = "starting a long command";
            onEvent({ kind: "text", delta: text });
            const call = { id: "sleep_1", tool: "execute_shell", input: { command: "node -e \"setTimeout(()=>{}, 60000)\"", timeoutMs: 60000 } };
            onEvent({ kind: "toolcall", toolCall: call });
            return { text, toolCalls: [call], finishReason: "tool_calls", usage: { inputTokens: 1, outputTokens: 1 } };
          },
        }) as ModelProvider,
    });
    const { url, cleanup } = await startTestServer(app);
    try {
      const wsRoot = join(tmpdir(), `forge-cancel-ws-${Date.now()}`);
      const { mkdirSync } = await import("node:fs");
      mkdirSync(wsRoot, { recursive: true });
      const created = await rpcCall(url, "create_session", { workspaceRoot: wsRoot, provider: "mock" });
      const sessionId = (created.result as { id: SessionId }).id;
      const sent = await rpcCall(url, "send_message", { sessionId, content: "run something long" });
      const agentId = (sent.result as { agentId: AgentId }).agentId;
      await new Promise((r) => setTimeout(r, 800)); // let the shell command start
      const cancel = await rpcCall(url, "cancel_agent", { agentId });
      assert.equal((cancel.result as { cancelled: boolean }).cancelled, true);
      let state = "";
      for (let i = 0; i < 40; i++) {
        const g = await rpcCall(url, "get_agent", { agentId });
        state = (g.result as { state: string }).state;
        if (state === "cancelled" || state === "failed") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(state, "cancelled");
      // Core still healthy and responsive after cancellation.
      const health = await fetch(`${url}/health`).then((r) => r.json()) as { ok: boolean };
      assert.equal(health.ok, true);
    } finally {
      await cleanup();
    }
  });
});
