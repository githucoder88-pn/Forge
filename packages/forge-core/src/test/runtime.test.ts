import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForgeRuntime } from '../runtime.js';
import { ScriptedProvider } from '../providers.js';
import { Workspace } from '../workspace.js';

describe('ForgeRuntime', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forge-rt-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('runGoal executes end-to-end: model → tool → file → report', async () => {
    const scripted = new ScriptedProvider({
      id: 's',
      script: [
        { content: 'creating', toolCalls: [{ name: 'create_file', input: { path: 'hello.txt', content: 'hello forge' } }] },
        { content: 'reporting', toolCalls: [{ name: 'report_progress', input: { progress: 100, currentAction: 'done' } }] },
        { content: 'Created hello.txt.' },
      ],
    });
    const rt = await ForgeRuntime.create({ projectDir: dir, storePath: ':memory:', providers: [scripted], config: { providers: {} } });
    try {
      const report = await rt.runGoal('Create a hello.txt greeting file');
      assert.equal(report.state, 'completed');
      assert.equal(new Workspace({ root: dir }).readFile('hello.txt'), 'hello forge');
      assert.ok(report.filesChanged.includes('hello.txt'));
      assert.equal(report.agents[0]?.state, 'completed');
      assert.equal(report.simulated, true); // scripted model → honestly flagged
    } finally {
      await rt.shutdown();
    }
  });

  test('planGoal builds an executable task graph from model JSON', async () => {
    const scripted = new ScriptedProvider({
      id: 's',
      script: [{
        content: JSON.stringify({
          goal: 'build auth',
          tasks: [
            { id: 'T1', title: 'Inspect auth', description: 'read code', depends_on: [] },
            { id: 'T2', title: 'Implement backend', description: 'api', depends_on: ['T1'] },
            { id: 'T3', title: 'Implement frontend', description: 'ui', depends_on: ['T1'] },
          ],
        }),
      }],
    });
    const rt = await ForgeRuntime.create({ projectDir: dir, storePath: ':memory:', providers: [scripted], config: { providers: {} } });
    try {
      const session = rt.ensureSession('plan-test');
      const tasks = await rt.planGoal(session.id, 'build auth');
      assert.equal(tasks.length, 3);
      assert.deepEqual(tasks[0]?.dependsOn, []);
      assert.equal(tasks[1]?.dependsOn.length, 1);
    } finally {
      await rt.shutdown();
    }
  });

  test('planGoal falls back to a single task when the planner fails', async () => {
    const scripted = new ScriptedProvider({ id: 's', script: [{ content: 'not json at all' }] });
    const rt = await ForgeRuntime.create({ projectDir: dir, storePath: ':memory:', providers: [scripted], config: { providers: {} } });
    try {
      const session = rt.ensureSession('plan-fallback');
      const tasks = await rt.planGoal(session.id, 'do the thing');
      assert.equal(tasks.length, 1);
      assert.ok(tasks[0]?.description.includes('planner note'));
    } finally {
      await rt.shutdown();
    }
  });

  test('reviewChanges reports blocked when nothing changed', async () => {
    const rt = await ForgeRuntime.create({ projectDir: dir, storePath: ':memory:', providers: [], config: { providers: {} } });
    try {
      const session = rt.ensureSession('review-test');
      const verdict = await rt.reviewChanges(session.id);
      assert.equal(verdict.verdict, 'blocked');
    } finally {
      await rt.shutdown();
    }
  });

  test('checkpoint/restore roundtrips orchestration state', async () => {
    const rt = await ForgeRuntime.create({ projectDir: dir, storePath: ':memory:', providers: [], config: { providers: {} } });
    try {
      const session = rt.ensureSession('ckpt-test');
      const agent = rt.agents.createAgent({ sessionId: session.id, name: 'a' });
      assert.ok(agent.id);
      const ckpt = await rt.createCheckpoint(session.id, 'snap');
      rt.scheduler.create({ sessionId: session.id, title: 'after-snapshot' });
      assert.equal(rt.scheduler.list(session.id).length, 1);
      await rt.restoreCheckpoint(ckpt.id);
      assert.equal(rt.scheduler.list(session.id).length, 0);
      assert.equal(rt.agents.list(session.id).length, 1);
    } finally {
      await rt.shutdown();
    }
  });
});
