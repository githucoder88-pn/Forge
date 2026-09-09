import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  AnthropicProvider, OllamaProvider, OpenAICompatibleProvider, ScriptedProvider, estimateTokens,
} from '../providers.js';
import { ForgeError } from '../errors.js';

function bodyOf(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise) => {
    let s = '';
    req.on('data', (d) => { s += d; });
    req.on('end', () => { try { resolvePromise(JSON.parse(s)); } catch { resolvePromise(s); } });
  });
}

function stub(responder: (req: IncomingMessage, body: unknown) => { status: number; json: unknown }): Promise<{ server: Server; url: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const body = await bodyOf(req);
      const out = responder(req, body);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('OpenAICompatibleProvider', () => {
  test('chat maps tool calls and usage', async () => {
    let seen: unknown;
    const { server, url } = await stub((req, body) => {
      seen = body;
      assert.equal(req.url, '/chat/completions');
      return {
        status: 200,
        json: {
          choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a' }) } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      };
    });
    try {
      const p = new OpenAICompatibleProvider({ id: 'stub', baseUrl: url });
      const res = await p.chat({
        model: 'm', messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' } }],
      });
      assert.equal(res.content, 'hi');
      assert.deepEqual(res.toolCalls, [{ id: 'c1', name: 'read_file', input: { path: 'a' } }]);
      assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5, reported: true });
      assert.equal((seen as { model: string }).model, 'm');
      assert.equal(res.simulated, undefined);
    } finally {
      server.close();
    }
  });

  test('maps HTTP errors to typed errors', async () => {
    const { server, url } = await stub(() => ({ status: 429, json: { error: { message: 'slow down' } } }));
    try {
      const p = new OpenAICompatibleProvider({ id: 'stub', baseUrl: url });
      await assert.rejects(() => p.chat({ model: 'm', messages: [] }), (e: unknown) => e instanceof ForgeError && e.code === 'RATE_LIMITED');
    } finally {
      server.close();
    }
    const auth = await stub(() => ({ status: 401, json: { error: { message: 'bad key' } } }));
    try {
      const p = new OpenAICompatibleProvider({ id: 'stub', baseUrl: auth.url });
      await assert.rejects(() => p.chat({ model: 'm', messages: [] }), (e: unknown) => e instanceof ForgeError && e.code === 'PROVIDER_ERROR');
    } finally {
      auth.server.close();
    }
  });
});

describe('AnthropicProvider', () => {
  test('chat maps tool_use blocks', async () => {
    const { server, url } = await stub(() => ({
      status: 200,
      json: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'shell', input: { command: 'ls' } }], usage: { input_tokens: 7, output_tokens: 3 } },
    }));
    try {
      const p = new AnthropicProvider({ id: 'a', baseUrl: url, apiKey: 'k' });
      const res = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'go' }] });
      assert.equal(res.content, 'ok');
      assert.deepEqual(res.toolCalls, [{ id: 't1', name: 'shell', input: { command: 'ls' } }]);
      assert.equal(res.usage.reported, true);
    } finally {
      server.close();
    }
  });
});

describe('OllamaProvider', () => {
  test('chat maps native tool calls', async () => {
    const { server, url } = await stub(() => ({
      status: 200,
      json: { message: { content: '', tool_calls: [{ function: { name: 'shell', arguments: { command: 'ls' } } }] }, prompt_eval_count: 4, eval_count: 2 },
    }));
    try {
      const p = new OllamaProvider({ id: 'o', baseUrl: url });
      const res = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'go' }] });
      assert.equal(res.toolCalls[0]?.name, 'shell');
      assert.equal(res.usage.inputTokens, 4);
    } finally {
      server.close();
    }
  });
});

describe('ScriptedProvider', () => {
  test('replays script and marks simulated', async () => {
    const p = new ScriptedProvider({ script: [{ content: 'one', toolCalls: [{ name: 'shell' }] }, { content: 'two' }] });
    const r1 = await p.chat({ model: 'm', messages: [] });
    assert.equal(r1.simulated, true);
    assert.equal(r1.toolCalls.length, 1);
    const r2 = await p.chat({ model: 'm', messages: [] });
    assert.equal(r2.content, 'two');
    const r3 = await p.chat({ model: 'm', messages: [] });
    assert.equal(r3.stopReason, 'script_exhausted');
  });
});

describe('estimateTokens', () => {
  test('roughly 4 chars per token', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('a'.repeat(400)), 100);
  });
});
