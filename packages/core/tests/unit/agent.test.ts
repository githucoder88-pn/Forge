import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canTransition, createAgent, isTerminal, transition } from "../../src/agent.ts";
import { createSessionId, createWorkspaceId, ForgeError } from "@forge/protocol";

function freshAgent() {
  return createAgent({
    sessionId: createSessionId(),
    workspaceId: createWorkspaceId(),
    provider: "mock",
    model: "mock",
    permissions: { mode: "workspace-write", approval: "risky-only" },
  });
}

describe("agent state machine", () => {
  it("walks the happy path Created -> Completed", () => {
    const a = freshAgent();
    assert.equal(a.state, "created");
    for (const next of ["idle", "planning", "executing", "waiting_for_tool", "executing", "completed"] as const) {
      transition(a, next);
    }
    assert.equal(a.state, "completed");
    assert.ok(isTerminal(a.state));
  });

  it("rejects illegal transitions safely", () => {
    const a = freshAgent();
    assert.throws(() => transition(a, "executing"), (e: unknown) => e instanceof ForgeError && e.code === "InvalidRequest");
    assert.equal(a.state, "created"); // unchanged
    assert.equal(canTransition("completed", "executing"), false);
  });

  it("supports pause/resume, failure, retry, and cancellation", () => {
    const a = freshAgent();
    transition(a, "idle");
    transition(a, "planning");
    transition(a, "executing");
    transition(a, "paused");
    transition(a, "executing");
    transition(a, "failed");
    assert.ok(isTerminal("failed") === true); // terminal for run(), but retryable...
    transition(a, "idle"); // ...via explicit failed -> idle retry transition
    assert.ok(isTerminal("idle") === false);
    transition(a, "cancelled");
    assert.ok(isTerminal("cancelled"));
  });

  it("initializes identity, permissions, and zero metrics", () => {
    const a = freshAgent();
    assert.match(a.id, /^agent_/);
    assert.deepEqual(Object.values(a.metrics).every((v) => v === 0), true);
    assert.equal(a.progress, 0);
  });
});
