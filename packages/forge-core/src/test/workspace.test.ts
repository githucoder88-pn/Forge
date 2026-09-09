import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../workspace.js';
import { ForgeError } from '../errors.js';

describe('Workspace', () => {
  let dir = '';
  let ws: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forge-ws-'));
    ws = new Workspace({ root: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('write/read/edit/delete roundtrip', () => {
    ws.writeFile('a/b.txt', 'hello');
    assert.equal(ws.readFile('a/b.txt'), 'hello');
    const r = ws.editFile('a/b.txt', 'hello', 'world');
    assert.equal(r.replacements, 1);
    assert.equal(ws.readFile('a/b.txt'), 'world');
    ws.deleteFile('a/b.txt');
    assert.equal(ws.exists('a/b.txt'), false);
  });

  test('create_file fails when file exists', () => {
    ws.writeFile('x.txt', '1');
    assert.throws(() => ws.createFile('x.txt', '2'), (e: unknown) => e instanceof ForgeError && e.code === 'ALREADY_EXISTS');
  });

  test('edit_file validates occurrences', () => {
    ws.writeFile('m.txt', 'a a a');
    assert.throws(() => ws.editFile('m.txt', 'missing', 'b'), (e: unknown) => e instanceof ForgeError && e.code === 'NOT_FOUND');
    assert.throws(() => ws.editFile('m.txt', 'a', 'b', { expectedOccurrences: 2 }), (e: unknown) => e instanceof ForgeError && e.code === 'INVALID_INPUT');
    const r = ws.editFile('m.txt', 'a', 'b', { occurrence: 'all' });
    assert.equal(r.replacements, 3);
  });

  test('refuses to escape the root', () => {
    assert.throws(() => ws.readFile('../outside.txt'), (e: unknown) => e instanceof ForgeError && e.code === 'PERMISSION_DENIED');
    assert.throws(() => ws.writeFile('/etc/forge-evil.txt', 'x'), (e: unknown) => e instanceof ForgeError && e.code === 'PERMISSION_DENIED');
  });

  test('list_directory skips ignored dirs', () => {
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'y.js'), '1');
    ws.writeFile('src/a.ts', '1');
    const entries = ws.listDirectory('.', { recursive: true });
    assert.ok(entries.some((e) => e.path === 'src/a.ts'));
    assert.ok(!entries.some((e) => e.path.includes('node_modules')));
  });

  test('AGENTS.md chains root → nested with precedence order', () => {
    ws.writeFile('AGENTS.md', 'root rules');
    ws.writeFile('frontend/AGENTS.md', 'frontend rules');
    const chain = ws.loadInstructions('frontend');
    assert.equal(chain.length, 2);
    assert.equal(chain[0]?.path, 'AGENTS.md');
    assert.equal(chain[1]?.path, 'frontend/AGENTS.md');
    const rootOnly = ws.loadInstructions('.');
    assert.equal(rootOnly.length, 1);
  });

  test('search_files finds literal matches', () => {
    ws.writeFile('a.js', 'const answer = 42;\nconsole.log(answer);\n');
    const matches = ws.searchFiles('answer');
    assert.equal(matches.length, 2);
    assert.equal(matches[0]?.line, 1);
  });

  test('search_symbols finds declarations', () => {
    ws.writeFile('b.ts', 'export class Widget {}\nexport function build() {}\nconst x = 1;\n');
    const syms = ws.searchSymbols('wid');
    assert.ok(syms.some((s) => s.name === 'Widget' && s.kind === 'class'));
    const fns = ws.searchSymbols('', { kinds: ['function'] });
    assert.ok(fns.some((s) => s.name === 'build'));
  });
});
