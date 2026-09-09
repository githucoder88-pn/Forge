import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextBuilder, ContextEngine, formatStats, makeItem, scoreFileRelevance } from '../context.js';
import { Workspace } from '../workspace.js';

describe('ContextBuilder', () => {
  test('fits items to budget by priority', () => {
    const b = new ContextBuilder(100);
    b.add(makeItem('file', 'low', 'x'.repeat(400), 1));
    b.add(makeItem('user', 'goal', 'important goal', 1000));
    const { items, stats } = b.build();
    assert.ok(stats.tokens <= 100);
    assert.ok(items.some((i) => i.label === 'goal'));
    assert.equal(stats.dropped, 1);
    assert.match(formatStats(stats), /tokens/);
  });

  test('deduplicates by key', () => {
    const b = new ContextBuilder(10000);
    b.add(makeItem('file', 'a', 'content', 5, 'same'));
    b.add(makeItem('file', 'a', 'content', 5, 'same'));
    assert.equal(b.build().items.length, 1);
  });

  test('compacts to target', () => {
    const b = new ContextBuilder(100000);
    b.add(makeItem('user', 'goal', 'keep me', 1000));
    for (let i = 0; i < 10; i++) b.add(makeItem('tool_output', `out${i}`, 'y'.repeat(4000), 10));
    const { stats } = b.compact(3000);
    assert.ok(stats.tokens <= 3000);
  });
});

describe('scoreFileRelevance', () => {
  test('matches terms in path and content', () => {
    const s1 = scoreFileRelevance('src/checkout.ts', 'export function checkout() {}', ['checkout']);
    const s2 = scoreFileRelevance('src/other.ts', 'nothing relevant here', ['checkout']);
    assert.ok(s1 > s2);
    assert.equal(scoreFileRelevance('a', 'b', []), 0);
  });
});

describe('ContextEngine', () => {
  test('builds bounded task context with instructions and files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-ctx-'));
    try {
      const ws = new Workspace({ root: dir });
      ws.writeFile('AGENTS.md', 'Use tabs.');
      ws.writeFile('src/checkout.ts', 'export function checkoutTotal() { return 1; }\n');
      ws.writeFile('src/unrelated.ts', 'export const z = 2;\n');
      const engine = new ContextEngine({ workspace: ws, defaultBudget: 4000 });
      const built = await engine.buildForTask({ goal: 'fix the checkout total calculation' });
      assert.ok(built.stats.tokens <= 4000);
      assert.ok(built.files.includes('src/checkout.ts'));
      const kinds = built.builder.build().items.map((i) => i.kind);
      assert.ok(kinds.includes('instructions'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
