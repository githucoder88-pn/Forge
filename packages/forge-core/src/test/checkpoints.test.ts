import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../events.js';
import { SqliteStore } from '../store.js';
import { CheckpointManager } from '../checkpoints.js';
import { runProcess } from '../tools.js';
import { sessionId } from '../ids.js';

async function gitAvailable(dir: string): Promise<boolean> {
  try {
    const r = await runProcess('git', ['--version'], { cwd: dir, timeoutMs: 10_000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

describe('CheckpointManager', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forge-ckpt-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('captures and restores git + orchestration state', async () => {
    if (!(await gitAvailable(dir))) return; // honest skip when git is absent
    await runProcess('git', ['init'], { cwd: dir, timeoutMs: 15_000 });
    writeFileSync(join(dir, 'f.txt'), 'v1');
    await runProcess('git', ['add', '-A'], { cwd: dir, timeoutMs: 15_000 });
    await runProcess('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'one'], { cwd: dir, timeoutMs: 15_000 });

    const mgr = new CheckpointManager(new SqliteStore({ path: ':memory:' }), new EventBus(), dir);
    const sess = sessionId();
    const ckpt = await mgr.create(sess, 'before-change', { agents: [], tasks: [{ id: 't1' }], teams: [] }, 10);
    assert.ok(ckpt.gitHead);
    assert.equal(ckpt.gitDirty, false);
    assert.equal(mgr.list(sess).length, 1);

    writeFileSync(join(dir, 'f.txt'), 'v2');
    // Guard: refuses to touch a dirty tree without explicit opt-in.
    await assert.rejects(() => mgr.restoreGit(ckpt.id));
    const restored = await mgr.restoreGit(ckpt.id, { allowDirtyRestore: true });
    assert.equal(restored.stashed, true);
    assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), 'v1');
    const stash = await runProcess('git', ['stash', 'list'], { cwd: dir, timeoutMs: 15_000 });
    assert.ok(stash.stdout.includes('forge-checkpoint-restore'));
  });

  test('works without git (state-only checkpoints)', async () => {
    const mgr = new CheckpointManager(new SqliteStore({ path: ':memory:' }), new EventBus(), dir);
    const ckpt = await mgr.create(sessionId(), 'state-only', { agents: [], tasks: [], teams: [] }, 0);
    assert.equal(ckpt.gitHead, undefined);
    await assert.rejects(() => mgr.restoreGit(ckpt.id));
  });
});
