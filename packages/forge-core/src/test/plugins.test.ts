import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../events.js';
import { createToolRegistry } from '../tools.js';
import { ModelRouter } from '../router.js';
import { loadPlugins } from '../plugins.js';

function fixturePlugin(dir: string, opts: { api?: string; entryJs?: string; name?: string } = {}): string {
  const plugDir = join(dir, 'myplug');
  mkdirSync(plugDir, { recursive: true });
  writeFileSync(join(plugDir, 'forge.plugin.json'), JSON.stringify({
    name: opts.name ?? 'myplug',
    version: '0.1.0',
    api: opts.api ?? 'forge-plugin/1',
    entry: './index.mjs',
  }));
  writeFileSync(join(plugDir, 'index.mjs'), opts.entryJs ?? `
    export async function activate(ctx) {
      ctx.registerTool(
        { name: 'shout', description: 'Uppercase text', minAutonomy: 'read-only',
          inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
        async (input) => ({ shouted: String(input.text).toUpperCase() }),
      );
      ctx.log('myplug activated');
    }
  `);
  return dir;
}

describe('plugins', () => {
  test('loads a local plugin and registers its tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-plug-'));
    try {
      fixturePlugin(dir);
      const tools = createToolRegistry();
      const loaded = await loadPlugins(dir, {
        tools, router: new ModelRouter(), bus: new EventBus(), projectDir: dir,
      });
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.manifest.name, 'myplug');
      assert.ok(tools.has('myplug.shout'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects unsupported API versions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-plug-'));
    try {
      fixturePlugin(dir, { api: 'forge-plugin/99' });
      await assert.rejects(() => loadPlugins(dir, {
        tools: createToolRegistry(), router: new ModelRouter(), bus: new EventBus(), projectDir: dir,
      }), /unsupported plugin API/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects plugins without activate()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-plug-'));
    try {
      fixturePlugin(dir, { entryJs: 'export const x = 1;' });
      await assert.rejects(() => loadPlugins(dir, {
        tools: createToolRegistry(), router: new ModelRouter(), bus: new EventBus(), projectDir: dir,
      }), /activate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores directories without manifests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-plug-'));
    try {
      mkdirSync(join(dir, 'not-a-plugin'));
      const loaded = await loadPlugins(dir, {
        tools: createToolRegistry(), router: new ModelRouter(), bus: new EventBus(), projectDir: dir,
      });
      assert.equal(loaded.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
