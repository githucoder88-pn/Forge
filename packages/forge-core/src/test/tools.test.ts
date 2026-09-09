import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { ApprovalGate } from '../permissions.js';
import { ToolContextBase, createToolRegistry, runProcess, validateInput } from '../tools.js';

function makeCtx(ws: Workspace, autonomy: ToolContextBase['autonomy'] = 'full-workspace'): ToolContextBase {
  return {
    workspace: ws, autonomy, policy: 'never', gate: new ApprovalGate(),
    bus: new EventBus(), defaultTimeoutMs: 30_000, verboseEvents: false,
  };
}

describe('validateInput', () => {
  test('enforces required + types + defaults', () => {
    const { value, errors } = validateInput(
      { type: 'object', required: ['path'], properties: { path: { type: 'string' }, max: { type: 'integer', default: 5 } }, additionalProperties: false },
      { path: 'a.txt' },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(value, { path: 'a.txt', max: 5 });
    const bad = validateInput({ type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, {});
    assert.ok(bad.errors.length > 0);
  });
});

describe('ToolRegistry', () => {
  let dir = '';
  let ws: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forge-tools-'));
    ws = new Workspace({ root: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('filesystem tools roundtrip through invoke', async () => {
    const reg = createToolRegistry();
    const ctx = makeCtx(ws);
    const w = await reg.invoke('write_file', { path: 'n.txt', content: 'hi' }, ctx);
    assert.equal(w.ok, true);
    const r = await reg.invoke('read_file', { path: 'n.txt' }, ctx);
    assert.equal(r.ok, true);
    assert.equal((r.result as { content: string }).content, 'hi');
    const e = await reg.invoke('edit_file', { path: 'n.txt', oldText: 'hi', newText: 'yo' }, ctx);
    assert.equal(e.ok, true);
    const l = await reg.invoke('list_directory', { path: '.' }, ctx);
    assert.ok(((l.result as { entries: { path: string }[] }).entries).some((x) => x.path === 'n.txt'));
  });

  test('invalid input fails closed', async () => {
    const reg = createToolRegistry();
    const r = await reg.invoke('read_file', {}, makeCtx(ws));
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'INVALID_INPUT');
  });

  test('permission enforcement denies under-privileged autonomy', async () => {
    const reg = createToolRegistry();
    const r = await reg.invoke('write_file', { path: 'x.txt', content: 'x' }, makeCtx(ws, 'read-only'));
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'PERMISSION_DENIED');
  });

  test('shell executes and captures output', async () => {
    const reg = createToolRegistry();
    const r = await reg.invoke('shell', { command: 'echo hello-forge' }, makeCtx(ws));
    assert.equal(r.ok, true);
    assert.ok(((r.result as { stdout: string }).stdout).includes('hello-forge'));
    assert.equal((r.result as { exitCode: number }).exitCode, 0);
  });

  test('shell timeout kills the command', async () => {
    const reg = createToolRegistry();
    const sleep = process.platform === 'win32' ? 'timeout /t 5 /nobreak' : 'sleep 5';
    const r = await reg.invoke('shell', { command: sleep, timeoutMs: 400 }, makeCtx(ws));
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'TIMEOUT');
  });

  test('shell streams output chunks', async () => {
    const reg = createToolRegistry();
    const chunks: string[] = [];
    const ctx = makeCtx(ws);
    ctx.onOutput = (c) => chunks.push(c.text);
    await reg.invoke('shell', { command: 'echo stream-me' }, ctx);
    assert.ok(chunks.join('').includes('stream-me'));
  });

  test('git tools work in a real repo', async () => {
    await runProcess('git', ['init'], { cwd: dir, timeoutMs: 15_000 });
    const reg = createToolRegistry();
    const ctx = makeCtx(ws);
    await reg.invoke('write_file', { path: 'g.txt', content: 'v1' }, ctx);
    const st = await reg.invoke('git_status', {}, ctx);
    assert.equal(st.ok, true);
    await reg.invoke('git_add', { paths: ['g.txt'] }, ctx);
    const commit = await reg.invoke('git_commit', { message: 'init' }, ctx);
    // commit may fail without git identity — accept either real outcome
    if (!commit.ok) {
      await runProcess('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: dir, timeoutMs: 15_000 });
    }
    const log = await reg.invoke('git_log', { limit: 3 }, ctx);
    assert.equal(log.ok, true);
    assert.ok(((log.result as { log: string }).log).includes('init'));
    await reg.invoke('edit_file', { path: 'g.txt', oldText: 'v1', newText: 'v2' }, ctx);
    const diff = await reg.invoke('git_diff', {}, ctx);
    assert.ok(((diff.result as { diff: string }).diff).includes('v2'));
  });

  test('inspect_environment returns real platform facts', async () => {
    const reg = createToolRegistry();
    const r = await reg.invoke('inspect_environment', {}, makeCtx(ws, 'read-only'));
    assert.equal(r.ok, true);
    const env = r.result as { platform: string; runtimes: { node: string } };
    assert.ok(env.platform.length > 0);
    assert.ok(env.runtimes.node.startsWith('v'));
  });
});
