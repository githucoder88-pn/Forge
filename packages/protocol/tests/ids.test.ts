import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentId,
  createEventId,
  createSessionId,
  createTaskId,
  createToolCallId,
  isIdOfKind,
  parseId,
} from "../src/ids.ts";

describe("forge ids", () => {
  it("generates prefixed, time-sortable uuidv7 ids", () => {
    const a = createSessionId();
    const b = createSessionId();
    assert.match(a, /^sess_[0-9a-f]{32}$/);
    assert.match(b, /^sess_[0-9a-f]{32}$/);
    assert.notEqual(a, b);
    assert.ok(a < b, `expected time ordering: ${a} < ${b}`);
  });

  it("keeps entity prefixes distinct", () => {
    assert.match(createAgentId(), /^agent_/);
    assert.match(createTaskId(), /^task_/);
    assert.match(createEventId(), /^evt_/);
    assert.match(createToolCallId(), /^tool_/);
  });

  it("parses ids and recovers the embedded timestamp", () => {
    const before = Date.now();
    const id = createSessionId();
    const after = Date.now();
    const parsed = parseId(id);
    assert.ok(parsed);
    assert.equal(parsed.kind, "session");
    assert.ok(parsed.timestampMs >= before && parsed.timestampMs <= after);
  });

  it("rejects malformed ids", () => {
    assert.equal(parseId("sess_nope"), null);
    assert.equal(parseId("nope"), null);
    assert.equal(parseId("sess_" + "0".repeat(32)), null); // bad version nibble
    assert.equal(parseId(""), null);
  });

  it("checks kind without throwing", () => {
    const id = createAgentId();
    assert.equal(isIdOfKind(id, "agent"), true);
    assert.equal(isIdOfKind(id, "session"), false);
  });

  it("preserves ordering under same-millisecond collisions", () => {
    const now = Date.now();
    const ids = Array.from({ length: 50 }, () => createAgentId(now));
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted);
    assert.equal(new Set(ids).size, 50);
  });
});
