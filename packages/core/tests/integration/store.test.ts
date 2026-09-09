import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../../src/agent.ts";
import { createApp } from "../../src/app.ts";
import { EventBus } from "../../src/eventBus.ts";
import { Logger } from "../../src/logger.ts";
import { createAgentId } from "@forge/protocol";
import { makeApp, makeWorkspace } from "../helpers.ts";

describe("persistence", () => {
  it("round-trips sessions, agents, events with deterministic ordering", () => {
    const t = makeApp();
    try {
      const wsRoot = makeWorkspace({ "a.txt": "x" });
      const session = t.app.sessions.createSession({ workspaceRoot: wsRoot, title: "t" });
      const agent = createAgent({
        sessionId: session.id, workspaceId: session.workspaceId,
        provider: "mock", model: "mock", permissions: session.config.permissions,
      });
      t.app.store.saveAgent(agent);
      assert.equal(t.app.sessions.getSession(session.id).title, "t");
      assert.equal(t.app.store.getAgent(agent.id)?.sessionId, session.id);
      const events = t.app.store.listEvents(session.id);
      assert.ok(events.length >= 1);
      assert.deepEqual(events.map((e) => e.seq), [...events.map((e) => e.seq)].sort((a, b) => a - b));
      const snap = t.app.sessions.snapshot(session.id);
      assert.equal(snap.session.id, session.id);
      assert.equal(snap.agents.length, 1);
    } finally {
      t.cleanup();
    }
  });

  it("survives core restart (close + reopen same dataDir)", () => {
    const t = makeApp();
    const wsRoot = makeWorkspace({ "a.txt": "x" });
    const session = t.app.sessions.createSession({ workspaceRoot: wsRoot });
    t.app.bus.emit(session.id, "agent.progress", { agentId: session.activeAgentId ?? ("agent_x" as never), progress: 0.5, message: "half" });
    t.cleanup();

    const app2 = createApp({ dataDir: t.dataDir, dbFilename: "test.db", logLevel: "error" });
    try {
      const s2 = app2.sessions.getSession(session.id);
      assert.equal(s2.workspaceRoot, wsRoot);
      const events = app2.store.listEvents(session.id);
      assert.ok(events.length >= 2);
      assert.equal(events[events.length - 1]?.type, "agent.progress");
    } finally {
      app2.close();
    }
  });

  it("event bus fans out live and replays missed events in seq order", () => {
    const t = makeApp();
    try {
      const session = t.app.sessions.createSession({ workspaceRoot: makeWorkspace() });
      const seen: number[] = [];
      const unsub = t.app.bus.subscribe(session.id, (e) => seen.push(e.seq));
      t.app.bus.emit(session.id, "agent.progress", { agentId: "agent_replay" as never, progress: 0.1, message: "a" });
      t.app.bus.emit(session.id, "agent.progress", { agentId: "agent_replay" as never, progress: 0.2, message: "b" });
      unsub();
      assert.deepEqual(seen, [2, 3]); // seq 1 was session.created
      const replay: number[] = [];
      t.app.bus.subscribe(session.id, (e) => replay.push(e.seq), 1);
      assert.deepEqual(replay, [2, 3]);
    } finally {
      t.cleanup();
    }
  });

  it("emits to wildcard subscribers across sessions", () => {
    const t = makeApp();
    try {
      const bus = new EventBus(t.app.store, new Logger("error"));
      const s1 = t.app.sessions.createSession({ workspaceRoot: makeWorkspace() });
      const got: string[] = [];
      const unsub = bus.subscribe("*", (e) => got.push(e.type));
      bus.emit(s1.id, "agent.progress", { agentId: createAgentId(), progress: 0, message: "x" });
      unsub();
      assert.deepEqual(got, ["agent.progress"]);
    } finally {
      t.cleanup();
    }
  });
});
