import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../events.js';

describe('EventBus', () => {
  test('emits ordered, timestamped, typed events', () => {
    const bus = new EventBus();
    const a = bus.emit({ type: 'session.created', data: { n: 1 } });
    const b = bus.emit({ type: 'session.resumed', data: { n: 2 } });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.ok(a.id.startsWith('evt_'));
    assert.ok(!Number.isNaN(Date.parse(a.ts)));
    assert.equal(a.v, 1);
  });

  test('subscribers receive matching events only', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe({ types: ['task.created'] }, (e) => { seen.push(e.type); });
    bus.emit({ type: 'task.created', data: {} });
    bus.emit({ type: 'task.completed', data: {} });
    assert.deepEqual(seen, ['task.created']);
  });

  test('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    let n = 0;
    const unsub = bus.subscribe(() => true, () => { n++; });
    bus.emit({ type: 'task.created', data: {} });
    unsub();
    bus.emit({ type: 'task.created', data: {} });
    assert.equal(n, 1);
  });

  test('replay returns events after a sequence', () => {
    const bus = new EventBus();
    bus.emit({ type: 'task.created', data: { i: 1 } });
    bus.emit({ type: 'task.created', data: { i: 2 } });
    bus.emit({ type: 'task.created', data: { i: 3 } });
    const replayed = bus.replay(1);
    assert.equal(replayed.length, 2);
    assert.deepEqual(replayed.map((e) => (e.data as { i: number }).i), [2, 3]);
  });

  test('ring buffer is bounded', () => {
    const bus = new EventBus({ ringCapacity: 100 });
    for (let i = 0; i < 150; i++) bus.emit({ type: 'task.updated', data: { i } });
    assert.equal(bus.history().length, 100);
    assert.equal(bus.latestSeq(), 150);
  });

  test('a failing subscriber does not break the bus', () => {
    const bus = new EventBus();
    bus.subscribe(() => true, () => { throw new Error('boom'); });
    let ok = 0;
    bus.subscribe(() => true, () => { ok++; });
    bus.emit({ type: 'task.created', data: {} });
    assert.equal(ok, 1);
  });

  test('setMinimumSeq continues persisted history', () => {
    const bus = new EventBus();
    bus.setMinimumSeq(500);
    const e = bus.emit({ type: 'task.created', data: {} });
    assert.equal(e.seq, 501);
  });
});
