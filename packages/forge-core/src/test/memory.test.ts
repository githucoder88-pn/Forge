import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import { MemoryStore } from '../memory.js';

describe('MemoryStore', () => {
  let mem: MemoryStore;

  beforeEach(() => {
    mem = new MemoryStore(new SqliteStore({ path: ':memory:' }));
  });

  test('put/get/list are scope-isolated', () => {
    mem.put('project', 'p1', 'db', 'postgres on :5432');
    mem.put('session', 's1', 'db', 'session note');
    assert.equal(mem.get('project', 'p1', 'db')?.value, 'postgres on :5432');
    assert.equal(mem.list('project', 'p1').length, 1);
    assert.equal(mem.list('project', 'other').length, 0);
  });

  test('put overwrites same key', () => {
    mem.put('global', 'g', 'k', 'v1');
    mem.put('global', 'g', 'k', 'v2');
    assert.equal(mem.get('global', 'g', 'k')?.value, 'v2');
    assert.equal(mem.list('global', 'g').length, 1);
  });

  test('search ranks key matches first', () => {
    mem.put('project', 'p1', 'auth-flow', 'uses oauth');
    mem.put('project', 'p1', 'notes', 'the auth flow is flaky');
    const hits = mem.search('auth-flow', { scopes: [{ scope: 'project', scopeId: 'p1' }] });
    assert.equal(hits[0]?.key, 'auth-flow');
  });

  test('delete removes entries', () => {
    const e = mem.put('task', 't1', 'k', 'v');
    mem.delete(e.id);
    assert.equal(mem.get('task', 't1', 'k'), undefined);
  });
});
