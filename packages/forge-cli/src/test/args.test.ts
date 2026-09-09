import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CliError, flag, flagBool, flagList, parseArgs, requirePositional } from '../args.js';

describe('parseArgs', () => {
  test('parses command, sub and flags', () => {
    const a = parseArgs(['tasks', 'create', '--session', 's1', '--title=x', '--json']);
    assert.equal(a.command, 'tasks');
    assert.equal(a.sub, 'create');
    assert.equal(flag(a, 'session'), 's1');
    assert.equal(flag(a, 'title'), 'x');
    assert.equal(flagBool(a, 'json'), true);
  });

  test('collects positionals after command/sub', () => {
    const a = parseArgs(['run', 'Fix it now', '--plan']);
    assert.equal(a.command, 'run');
    assert.equal(a.sub, 'Fix it now');
    assert.deepEqual(a.positional, []);
  });

  test('supports -- separator and short flags', () => {
    const a = parseArgs(['-h']);
    assert.equal(flagBool(a, 'help'), true);
    const b = parseArgs(['run', '--', '--not-a-flag']);
    assert.equal(b.command, 'run');
    assert.equal(b.sub, '--not-a-flag');
    assert.deepEqual(b.positional, []);
  });

  test('flagList splits comma lists', () => {
    const a = parseArgs(['tasks', 'run', '--only', 'a,b ,c']);
    assert.deepEqual(flagList(a, 'only'), ['a', 'b', 'c']);
  });

  test('requirePositional throws CliError', () => {
    const a = parseArgs(['agents', 'inspect']);
    assert.throws(() => requirePositional(a, 0, 'agent id'), CliError);
  });
});
