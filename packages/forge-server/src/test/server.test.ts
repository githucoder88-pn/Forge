import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForgeRuntime, ScriptedProvider, Workspace } from '@forge/core';
import { WebSocket } from 'ws';
import { ForgeServer } from '../server.js';

describe('ForgeServer', () => {
  let dir = '';
  let rt: ForgeRuntime;
  let server: ForgeServer;
  let base = '';

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'forge-srv-'));
    new Workspace({ root: dir }).writeFile('hello.txt', 'hi');
    rt = await ForgeRuntime.create({
      projectDir: dir, storePath: ':memory:',
      providers: [new ScriptedProvider({ id: 's', script: [] })],
      config: { providers: {} },
    });
    server = new ForgeServer({ runtime: rt, port: 0, host: '127.0.0.1', token: 'test-token' });
    const { url } = await server.start();
    base = url;
  });

  after(async () => {
    await server.stop();
    await rt.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  async function rpc(method: string, params?: unknown): Promise<unknown> {
    const res = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
    });
    const json = await res.json() as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
    return json.result;
  }

  test('health reports protocol and project', async () => {
    const res = await fetch(`${base}/health`);
    const json = await res.json() as { ok: boolean; protocol: string; projectDir: string };
    assert.equal(json.ok, true);
    assert.equal(json.protocol, 'forge/1');
    assert.equal(json.projectDir, dir);
  });

  test('sessions + tools roundtrip over RPC', async () => {
    const session = await rpc('session.create', { projectDir: dir }) as { id: string };
    assert.ok(session.id.startsWith('sess_'));
    const read = await rpc('tool.invoke', { tool: 'read_file', input: { path: 'hello.txt' }, sessionId: session.id }) as { ok: boolean; result: { content: string } };
    assert.equal(read.ok, true);
    assert.equal(read.result.content, 'hi');
    const sessions = await rpc('session.list') as unknown[];
    assert.ok(sessions.length >= 1);
  });

  test('unknown method and bad params fail with typed errors', async () => {
    const res = await fetch(`${base}/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'nope.nope', params: {} }),
    });
    const json = await res.json() as { error: { code: number } };
    assert.equal(json.error.code, -32601);
    await assert.rejects(() => rpc('session.get', {}));
  });

  test('agent lifecycle over RPC is detached and observable', async () => {
    const session = await rpc('session.create', { projectDir: dir }) as { id: string };
    const agent = await rpc('agent.create', { sessionId: session.id, name: 'rpc-agent' }) as { id: string; state: string };
    assert.equal(agent.state, 'created');
    const started = await rpc('agent.start', { agentId: agent.id, goal: 'do nothing' }) as { accepted: boolean };
    assert.equal(started.accepted, true);
    // Script exhausted → agent completes; poll state.
    for (let i = 0; i < 50; i++) {
      const cur = await rpc('agent.get', { agentId: agent.id }) as { state: string };
      if (cur.state === 'completed' || cur.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const cur = await rpc('agent.get', { agentId: agent.id }) as { state: string };
    assert.ok(['completed', 'failed'].includes(cur.state));
    const replay = await rpc('events.replay', { sessionId: session.id, types: ['agent.started'] }) as unknown[];
    assert.ok(replay.length >= 1);
  });

  test('SSE streams live events', async () => {
    const session = await rpc('session.create', { projectDir: dir }) as { id: string };
    const res = await fetch(`${base}/events?sessionId=${session.id}`);
    assert.equal(res.status, 200);
    const reader = res.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let buf = '';
    const pump = (async (): Promise<void> => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    })();
    await rpc('message.send', { sessionId: session.id, from: 't', to: '*', type: 'broadcast', body: 'hello-sse' });
    for (let i = 0; i < 50 && !buf.includes('hello-sse'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await reader.cancel();
    await pump.catch(() => undefined);
    assert.ok(buf.includes('hello-sse'));
    assert.ok(buf.includes('agent.message.sent'));
  });

  test('WebSocket subscribes and receives events', async () => {
    const session = await rpc('session.create', { projectDir: dir }) as { id: string };
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const received: string[] = [];
    await new Promise<void>((resolvePromise) => ws.on('open', () => resolvePromise()));
    ws.on('message', (raw) => received.push(String(raw)));
    ws.send(JSON.stringify({ type: 'subscribe', filter: { sessionId: session.id } }));
    await new Promise((r) => setTimeout(r, 100));
    await rpc('message.send', { sessionId: session.id, from: 't', to: '*', type: 'broadcast', body: 'hello-ws' });
    for (let i = 0; i < 50 && !received.join('').includes('hello-ws'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    ws.close();
    assert.ok(received.join('').includes('hello-ws'));
  });
});
