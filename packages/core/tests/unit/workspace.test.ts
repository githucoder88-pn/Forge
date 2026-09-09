import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForgeError } from "@forge/protocol";
import { Workspace } from "../../src/workspace.ts";
import { makeWorkspace } from "../helpers.ts";

describe("workspace jail", () => {
  it("resolves inside paths and rejects traversal escapes", () => {
    const root = makeWorkspace({ "a.txt": "hi" });
    const ws = new Workspace(root);
    assert.ok(ws.resolvePath("a.txt").startsWith(root));
    // NOTE: "..\\..\\x" is traversal on Windows but a legal literal filename on POSIX.
    const evil = ["../x", "../../etc/passwd", "/etc/passwd", "~/x", "a/../../b"];
    if (process.platform === "win32") evil.push("..\\..\\x");
    for (const p of evil) {
      assert.throws(() => ws.resolvePath(p), (e: unknown) => e instanceof ForgeError && (e.code === "WorkspaceViolation" || e.code === "InvalidRequest"), p);
    }
  });

  it("rejects NUL bytes and home expansion", () => {
    const ws = new Workspace(makeWorkspace());
    assert.throws(() => ws.resolvePath("a\0b"));
    assert.throws(() => ws.resolvePath("~/x"));
  });

  it("reads, writes, and lists through the boundary", async () => {
    const ws = new Workspace(makeWorkspace({ "sub/a.txt": "hello" }));
    const r = await ws.readFile("sub/a.txt", 1_000_000);
    assert.equal(r.content, "hello");
    assert.equal(r.lines, 1);
    await ws.writeFile("sub/b.txt", "new", { createDirs: true });
    const entries = await ws.listDir("sub");
    assert.deepEqual(entries.map((e) => e.name).sort(), ["a.txt", "b.txt"]);
  });

  it("returns NotFound for missing files", async () => {
    const ws = new Workspace(makeWorkspace());
    await assert.rejects(() => ws.readFile("nope.txt", 1000), (e: unknown) => e instanceof ForgeError && e.code === "NotFound");
  });
});
