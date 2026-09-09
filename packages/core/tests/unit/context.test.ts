import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildContext, estimateTokens } from "../../src/context.ts";
import { loadInstructions } from "../../src/agentsMd.ts";
import { Workspace } from "../../src/workspace.ts";
import { makeWorkspace } from "../helpers.ts";
import { createMessageId, createSessionId, type Message } from "@forge/protocol";

describe("AGENTS.md loader", () => {
  it("loads root-first nested instructions", async () => {
    const root = makeWorkspace({
      "AGENTS.md": "root rules",
      "frontend/AGENTS.md": "frontend rules",
      "frontend/app.ts": "x",
    });
    const ws = new Workspace(root);
    const files = await loadInstructions(ws, "frontend/app.ts");
    assert.deepEqual(files.map((f) => f.path), ["AGENTS.md", "frontend/AGENTS.md"]);
    const top = await loadInstructions(ws, ".");
    assert.deepEqual(top.map((f) => f.path), ["AGENTS.md"]);
  });

  it("returns empty when no instructions exist", async () => {
    const ws = new Workspace(makeWorkspace({ "a.txt": "x" }));
    assert.deepEqual(await loadInstructions(ws, "."), []);
  });
});

describe("context builder", () => {
  function msg(role: Message["role"], content: string): Message {
    return { id: createMessageId(), sessionId: createSessionId(), agentId: null, role, content, createdAt: new Date().toISOString() };
  }

  it("is bounded, token-aware, and deduplicated", async () => {
    const ws = new Workspace(makeWorkspace({ "AGENTS.md": "be nice" }));
    const history = Array.from({ length: 50 }, (_, i) => msg(i % 2 ? "agent" : "user", `message ${i} `.padEnd(2000, "x")));
    const toolResults = Array.from({ length: 20 }, (_, i) => ({ toolCallId: `t${i}`, tool: "read_file", output: "same output ".repeat(500) }));
    const built = await buildContext({ workspace: ws, history, toolResults, userRequest: "fix it", budgetTokens: 4000 });
    assert.ok(built.system.includes("be nice"));
    assert.ok(built.estimatedTokens <= 6000, `tokens=${built.estimatedTokens}`);
    assert.ok(built.truncated.conversation || built.truncated.toolResults);
    const dupes = built.messages.filter((m) => m.content.includes("duplicate of previous"));
    assert.ok(dupes.length > 0, "identical tool results should collapse");
  });

  it("estimates tokens sanely", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("x".repeat(400)), 100);
  });
});
