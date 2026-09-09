import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import { SessionManager } from '../sessions.js';
import { EventBus } from '../events.js';
import { agentId, taskId } from '../ids.js';

describe('SessionManager', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager(new SqliteStore({ path: ':memory:' }), new EventBus());
  });

  test('create/resume/close lifecycle', () => {
    const s = mgr.create({ name: 'work', projectDir: '/tmp/proj' });
    assert.equal(s.status, 'active');
    const resumed = mgr.resume(s.id);
    assert.equal(resumed.id, s.id);
    const closed = mgr.close(s.id);
    assert.equal(closed.status, 'closed');
    // resuming a closed session reopens it
    assert.equal(mgr.resume(s.id).status, 'active');
  });

  test('attach links agents and tasks without duplicates', () => {
    const s = mgr.create({ projectDir: '/tmp/proj' });
    const a = agentId();
    const t = taskId();
    mgr.attach(s.id, { agentId: a });
    mgr.attach(s.id, { agentId: a, taskId: t });
    const got = mgr.get(s.id);
    assert.deepEqual(got.agentIds, [a]);
    assert.deepEqual(got.taskIds, [t]);
  });

  test('list returns all sessions', () => {
    mgr.create({ projectDir: '/a' });
    mgr.create({ projectDir: '/b' });
    assert.equal(mgr.list().length, 2);
  });
});
