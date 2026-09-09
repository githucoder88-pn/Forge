import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { ForgeError } from "@forge/protocol";
import { makeApp, makeWorkspace } from "../helpers.ts";

function ctxFor(t: ReturnType<typeof makeApp>, wsRoot: string, mode: "read-only" | "workspace-write" = "workspace-write") {
  const session = t.app.sessions.createSession({ workspaceRoot: wsRoot, permissions: { mode } });
  return { session, toolCtx: t.app.sessions.toolContextFor(session.id) };
}

describe("filesystem tools", () => {
  it("reads, edits, writes, and searches end to end", async () => {
    const t = makeApp();
    try {
      const { toolCtx } = ctxFor(t, makeWorkspace({ "src/a.ts": "export const x = 1;\n", "README.md": "hello world\n" }));
      const reg = t.app.registry;
      const signal = new AbortController().signal;

      const read = await reg.execute(toolCtx, "read_file", { path: "src/a.ts" }, signal);
      assert.equal(read.ok, true);
      assert.match(JSON.stringify(read.result), /x = 1/);

      const edit = await reg.execute(toolCtx, "edit_file", { path: "src/a.ts", oldText: "x = 1", newText: "x = 2" }, signal);
      assert.equal(edit.ok, true);

      const search = await reg.execute(toolCtx, "search_files", { query: "x = 2" }, signal);
      assert.equal(search.ok, true);
      assert.equal((search.result as { matches: unknown[] }).matches.length, 1);

      const bad = await reg.execute(toolCtx, "edit_file", { path: "src/a.ts", oldText: "missing", newText: "y" }, signal);
      assert.equal(bad.ok, false); // tool logic failure -> result, not throw
    } finally {
      t.cleanup();
    }
  });

  it("enforces read-only mode and path jail through the registry", async () => {
    const t = makeApp();
    try {
      const { toolCtx } = ctxFor(t, makeWorkspace({ "a.txt": "x" }), "read-only");
      const signal = new AbortController().signal;
      await assert.rejects(
        () => t.app.registry.execute(toolCtx, "write_file", { path: "b.txt", content: "y" }, signal),
        (e: unknown) => e instanceof ForgeError && e.code === "PermissionDenied",
      );
      await assert.rejects(
        () => t.app.registry.execute(toolCtx, "read_file", { path: "../escape.txt" }, signal),
        (e: unknown) => e instanceof ForgeError && e.code === "WorkspaceViolation",
      );
    } finally {
      t.cleanup();
    }
  });

  it("rejects invalid tool input and unknown tools", async () => {
    const t = makeApp();
    try {
      const { toolCtx } = ctxFor(t, makeWorkspace());
      const signal = new AbortController().signal;
      await assert.rejects(() => t.app.registry.execute(toolCtx, "read_file", {}, signal), ForgeError);
      await assert.rejects(() => t.app.registry.execute(toolCtx, "nope", {}, signal), ForgeError);
    } finally {
      t.cleanup();
    }
  });
});

describe("shell tool", () => {
  it("captures stdout, stderr, exit code, and duration", async () => {
    const t = makeApp();
    try {
      const { toolCtx } = ctxFor(t, makeWorkspace());
      const signal = new AbortController().signal;
      const res = await t.app.registry.execute(toolCtx, "execute_shell", { command: "echo out && echo err 1>&2" }, signal);
      assert.equal(res.ok, true);
      const r = res.result as { stdout: string; stderr: string; exitCode: number; success: boolean };
      assert.match(r.stdout, /out/);
      assert.match(r.stderr, /err/);
      assert.equal(r.exitCode, 0);
      assert.equal(r.success, true);
    } finally {
      t.cleanup();
    }
  });

  it("reports nonzero exit as structured failure and denies blocked binaries", async () => {
    const t = makeApp();
    try {
      const { toolCtx } = ctxFor(t, makeWorkspace());
      const signal = new AbortController().signal;
      const res = await t.app.registry.execute(toolCtx, "execute_shell", { command: "node -e \"process.exit(3)\"" }, signal);
      assert.equal(res.ok, true);
      assert.equal((res.result as { exitCode: number }).exitCode, 3);
      await assert.rejects(
        () => t.app.registry.execute(toolCtx, "execute_shell", { command: "rm -rf /tmp/x" }, signal),
        (e: unknown) => e instanceof ForgeError && e.code === "PermissionDenied",
      );
    } finally {
      t.cleanup();
    }
  });

  it("enforces timeouts and cancellation without orphaning processes", async () => {
    const t = makeApp();
    try {
      const { toolCtx } = ctxFor(t, makeWorkspace());
      const timeoutRes = await t.app.registry.execute(toolCtx, "execute_shell", { command: "node -e \"setTimeout(()=>{}, 30000)\"", timeoutMs: 300 }, new AbortController().signal);
      assert.equal(timeoutRes.ok, false);
      assert.match(String(timeoutRes.error), /timed out/);

      const c = new AbortController();
      const p = t.app.registry.execute(toolCtx, "execute_shell", { command: "node -e \"setTimeout(()=>{}, 30000)\"" }, c.signal);
      setTimeout(() => c.abort(new Error("test cancel")), 200);
      await assert.rejects(() => p, (e: unknown) => e instanceof ForgeError && e.code === "Cancelled");
    } finally {
      t.cleanup();
    }
  });
});

describe("git + test tools", () => {
  it("inspects git status/diff/log through the command pipeline", async () => {
    const t = makeApp();
    try {
      const root = makeWorkspace({ "a.txt": "v1" });
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: root });
      const { toolCtx } = ctxFor(t, root);
      const signal = new AbortController().signal;
      const status = await t.app.registry.execute(toolCtx, "git_status", {}, signal);
      assert.equal(status.ok, true);
      const log = await t.app.registry.execute(toolCtx, "git_log", { limit: 5 }, signal);
      assert.match(JSON.stringify(log.result), /init/);
      // Modify + diff through the same pipeline.
      await t.app.registry.execute(toolCtx, "write_file", { path: "a.txt", content: "v2" }, signal);
      const diff = await t.app.registry.execute(toolCtx, "git_diff", {}, signal);
      assert.equal(diff.ok, true);
      assert.match(JSON.stringify(diff.result), /v1/);
      assert.match(JSON.stringify(diff.result), /v2/);
    } finally {
      t.cleanup();
    }
  });

  it("detects and runs a node test suite with structured pass/fail", async () => {
    const t = makeApp();
    try {
      const root = makeWorkspace({
        // Plain script, NOT node:test (nested node --test is skipped by the runner).
        "package.json": JSON.stringify({ name: "fx", scripts: { test: "node test/run.js" } }),
        "test/run.js": "const assert=require('node:assert/strict');assert.equal(1+1,2);console.log('ok');",
      });
      const { toolCtx } = ctxFor(t, root);
      const res = await t.app.registry.execute(toolCtx, "run_tests", {}, new AbortController().signal);
      assert.equal(res.ok, true);
      assert.equal((res.result as { passed: boolean }).passed, true);
    } finally {
      t.cleanup();
    }
  });

  it("detects and runs a build script with structured status", async () => {
    const t = makeApp();
    try {
      const root = makeWorkspace({
        "package.json": JSON.stringify({ name: "fx", scripts: { build: "node -e \"console.log('built')\"" } }),
      });
      const { toolCtx } = ctxFor(t, root);
      const res = await t.app.registry.execute(toolCtx, "run_build", {}, new AbortController().signal);
      assert.equal(res.ok, true);
      assert.equal((res.result as { success: boolean }).success, true);
      assert.match(JSON.stringify(res.result), /built/);
    } finally {
      t.cleanup();
    }
  });

  it("reports failing suites honestly", async () => {
    const t = makeApp();
    try {
      const root = makeWorkspace({
        "package.json": JSON.stringify({ name: "fx", scripts: { test: "node -e \"process.exit(1)\"" } }),
      });
      const { toolCtx } = ctxFor(t, root);
      const res = await t.app.registry.execute(toolCtx, "run_tests", {}, new AbortController().signal);
      assert.equal(res.ok, true);
      assert.equal((res.result as { passed: boolean }).passed, false);
    } finally {
      t.cleanup();
    }
  });
});
