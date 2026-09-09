import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import { TaskScheduler } from '../tasks.js';
import { sessionId } from '../ids.js';
import { ForgeError } from '../errors.js';

describe('TaskScheduler', () => {
  let store: SqliteStore;
  let sched: TaskScheduler;
  const sess = sessionId();

  beforeEach(() => {
    store = new SqliteStore({ path: ':memory:' });
    sched = new TaskScheduler(store);
  });

  test('executes a chain in dependency order', async () => {
    const a = sched.create({ sessionId: sess, title: 'A' });
    const b = sched.create({ sessionId: sess, title: 'B', dependsOn: [a.id] });
    const c = sched.create({ sessionId: sess, title: 'C', dependsOn: [b.id] });
    const order: string[] = [];
    await sched.runAll(sess, async (t) => { order.push(t.title); return {}; });
    assert.deepEqual(order, ['A', 'B', 'C']);
    assert.equal(sched.get(c.id).status, 'completed');
  });

  test('runs independent tasks in parallel', async () => {
    sched.create({ sessionId: sess, title: 'A' });
    sched.create({ sessionId: sess, title: 'B' });
    let concurrent = 0;
    let peak = 0;
    await sched.runAll(sess, async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return {};
    }, { maxParallel: 2 });
    assert.equal(peak, 2);
  });

  test('failure propagates to dependents as blocked', async () => {
    const a = sched.create({ sessionId: sess, title: 'A', maxRetries: 0 });
    const b = sched.create({ sessionId: sess, title: 'B', dependsOn: [a.id] });
    await sched.runAll(sess, async (t) => {
      if (t.id === a.id) throw new Error('A exploded');
      return {};
    });
    assert.equal(sched.get(a.id).status, 'failed');
    assert.equal(sched.get(b.id).status, 'blocked');
  });

  test('retries then succeeds', async () => {
    const a = sched.create({ sessionId: sess, title: 'A', maxRetries: 2 });
    let n = 0;
    await sched.runAll(sess, async () => {
      n++;
      if (n < 2) throw new Error('flaky');
      return {};
    });
    assert.equal(sched.get(a.id).status, 'completed');
    assert.equal(sched.get(a.id).retries, 1);
  });

  test('detects dependency cycles', () => {
    const a = sched.create({ sessionId: sess, title: 'A' });
    const b = sched.create({ sessionId: sess, title: 'B', dependsOn: [a.id] });
    assert.throws(() => sched.update(a.id, { dependsOn: [b.id] }), (e: unknown) => e instanceof ForgeError && e.code === 'DEPENDENCY_CYCLE');
  });

  test('rejects unknown dependencies', () => {
    assert.throws(
      () => sched.create({ sessionId: sess, title: 'X', dependsOn: ['task_missing' as never] }),
      (e: unknown) => e instanceof ForgeError && e.code === 'NOT_FOUND',
    );
  });

  test('reports deadlock instead of hanging', async () => {
    const dep = sched.create({ sessionId: sess, title: 'dep' });
    sched.pause(dep.id);
    const child = sched.create({ sessionId: sess, title: 'child', dependsOn: [dep.id] });
    await assert.rejects(
      () => sched.runAll(sess, async () => ({}), { only: [child.id] }),
      (e: unknown) => e instanceof ForgeError && e.code === 'DEADLOCK',
    );
  });

  test('cancel stops a running task', async () => {
    const a = sched.create({ sessionId: sess, title: 'A' });
    const run = sched.runAll(sess, async (_t, ctx) => {
      await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new ForgeError('CANCELLED', 'x'))));
      return {};
    });
    await new Promise((r) => setTimeout(r, 30));
    sched.cancel(a.id);
    await run;
    assert.equal(sched.get(a.id).status, 'cancelled');
  });

  test('topoOrder returns dependencies first', () => {
    const a = sched.create({ sessionId: sess, title: 'A' });
    const b = sched.create({ sessionId: sess, title: 'B', dependsOn: [a.id] });
    const order = sched.topoOrder(sess).map((t) => t.id);
    assert.ok(order.indexOf(a.id) < order.indexOf(b.id));
  });
});
