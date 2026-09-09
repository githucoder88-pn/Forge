import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForgeRuntime } from '@forge/core';
import { ForgeServer } from '@forge/server';
import { ForgeClient } from '../index.js';

describe('ForgeClient', () => {
  let dir = '';
  let rt: ForgeRuntime;
  let server: ForgeServer;
  let client: ForgeClient;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'forge-client-'));
    rt = await ForgeRuntime.create({ projectDir: dir, storePath: ':memory:', config: { providers: {} } });
    server = new ForgeServer({ runtime: rt, port: 0, host: '127.0.0.1', token: 't' });
    const { url } = await server.start();
    client = new ForgeClient({ url });
  });

  after(async () => {
    await server.stop();
    await rt.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('typed RPC roundtrips', async () => {
    const health = await client.health();
    assert.equal(health.ok, true);
    const session = await client.sessionCreate({ projectDir: dir });
    assert.ok(session.id.startsWith('sess_'));
    const agent = await client.agentCreate({ sessionId: session.id, name: 'c1' });
    assert.equal(agent.name, 'c1');
    const agents = await client.agentList(session.id);
    assert.equal(agents.length, 1);
    const msg = await client.messageSend({ from: agent.id, to: '*', type: 'broadcast', body: 'hi', sessionId: session.id });
    assert.equal(msg.body, 'hi');
    const conv = await client.conversation({ sessionId: session.id });
    assert.equal(conv.length, 1);
    const status = await client.runtimeStatus() as { sessions: number };
    assert.ok(status.sessions >= 1);
  });

  test('event subscription receives live events', async () => {
    const session = await client.sessionCreate({ projectDir: dir });
    const seen: string[] = [];
    const unsub = client.subscribeEvents({
      filter: { sessionId: session.id },
      onEvent: (e) => { seen.push(`${e.type}:${JSON.stringify(e.data)}`); },
    });
    await new Promise((r) => setTimeout(r, 200));
    await client.messageSend({ from: 'x', to: '*', type: 'broadcast', body: 'live-123', sessionId: session.id });
    for (let i = 0; i < 50 && !seen.join('').includes('live-123'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    unsub();
    assert.ok(seen.join('').includes('live-123'));
  });

  test('RPC errors surface as ForgeClientError', async () => {
    await assert.rejects(() => client.sessionGet('sess_missing'), /Session not found/);
  });
});
