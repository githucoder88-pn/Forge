import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORGE_METHODS, PROTOCOL_VERSION, failure, isForgeMethod, optNumber,
  optString, paramsObject, reqString, success,
} from '../index.js';

describe('protocol', () => {
  test('version is pinned', () => {
    assert.equal(PROTOCOL_VERSION, 'forge/1');
  });

  test('method catalog covers the required surface', () => {
    const required = [
      'session.create', 'session.resume', 'agent.start', 'agent.pause', 'agent.cancel',
      'task.create', 'task.run', 'team.create', 'message.send', 'tool.invoke',
      'workspace.read', 'model.status', 'checkpoint.create', 'checkpoint.restore',
      'events.replay', 'runtime.run', 'demo.run',
    ];
    for (const m of required) assert.ok(isForgeMethod(m), m);
    assert.ok(FORGE_METHODS.length > 50);
  });

  test('envelopes are well-formed', () => {
    assert.deepEqual(success(1, { a: 1 }), { jsonrpc: '2.0', id: 1, result: { a: 1 } });
    const f = failure(2, -32602, 'bad', { x: 1 });
    assert.equal(f.error.code, -32602);
  });

  test('param helpers validate strictly', () => {
    assert.throws(() => paramsObject([]));
    assert.throws(() => reqString({}, 'id'));
    assert.equal(reqString({ id: 'x' }, 'id'), 'x');
    assert.equal(optString({}, 'a'), undefined);
    assert.throws(() => optString({ a: 1 }, 'a'));
    assert.equal(optNumber({ n: 2 }, 'n'), 2);
  });
});
