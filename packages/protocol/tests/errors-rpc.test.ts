import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForgeError } from "../src/errors.ts";
import { PARAM_SCHEMAS, RpcRequestSchema } from "../src/rpc.ts";
import { EVENT_TYPES, isEventType } from "../src/events.ts";

describe("forge errors", () => {
  it("serializes and rehydrates across the protocol", () => {
    const err = new ForgeError("PermissionDenied", "nope", { details: { tool: "shell" } });
    const json = JSON.parse(JSON.stringify(err.toJSON()));
    const back = ForgeError.fromJSON(json);
    assert.equal(back.code, "PermissionDenied");
    assert.equal(back.codeNumber, -32002);
    assert.equal(back.retryable, false);
    assert.deepEqual(back.details, { tool: "shell" });
  });

  it("coerces unknown throws without leaking raw internals", () => {
    const e = ForgeError.fromUnknown(new Error("boom"));
    assert.equal(e.code, "ProtocolFailure");
    const enoent = ForgeError.fromUnknown(Object.assign(new Error("x"), { code: "ENOENT" }));
    assert.equal(enoent.code, "NotFound");
  });
});

describe("rpc schemas", () => {
  it("validates requests and params", () => {
    assert.ok(RpcRequestSchema.safeParse({ jsonrpc: "2.0", id: 1, method: "health" }).success);
    assert.ok(!RpcRequestSchema.safeParse({ jsonrpc: "1.0", id: 1 }).success);
    assert.ok(PARAM_SCHEMAS.send_message.safeParse({ sessionId: "sess_x", content: "hi" }).success);
    assert.ok(!PARAM_SCHEMAS.send_message.safeParse({ sessionId: "sess_x", content: "" }).success);
  });
});

describe("events", () => {
  it("covers the phase-1 event surface", () => {
    for (const t of ["session.created", "agent.state_changed", "tool.started", "model.stream", "test.failed"]) {
      assert.ok(isEventType(t), t);
    }
    assert.ok(EVENT_TYPES.length >= 28);
  });
});
