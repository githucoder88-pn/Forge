import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, ForgeEvent } from '../events.js';
import { SqliteStore } from '../store.js';
import { Workspace } from '../workspace.js';
import { ApprovalGate } from '../permissions.js';
import { createToolRegistry } from '../tools.js';
import { ScriptedProvider } from '../providers.js';
import { ModelRouter } from '../router.js';
import { ContextEngine } from '../context.js';
import { MemoryStore } from '../memory.js';
import { TaskScheduler } from '../tasks.js';
import { MessageBus } from '../messaging.js';
import { AgentRuntime } from '../agents.js';
import { sessionId } from '../ids.js';

type Script = { content?: string; toolCalls?: { name: string; input?: unknown }[] }[];

function makeRuntime(dir: string, script: Script): { agents: AgentRuntime; bus: EventBus; store: SqliteStore; events: ForgeEvent[] } {
  const store = new SqliteStore({ path: ':memory:' });
  const bus = new EventBus();
  const events: ForgeEvent[] = [];
  bus.subscribe(() => true, (e) => { events.push(e); });
  const router = new ModelRouter({ maxRetries: 0 });
  router.registerProvider(new ScriptedProvider({ id: 's', script }));
  const agents = new AgentRuntime({
    store, bus,
    tools: createToolRegistry(),
    router,
    gate: new ApprovalGate(),
    scheduler: new TaskScheduler(store, bus),
    messages: new MessageBus(store, bus),
    memory: new MemoryStore(store),
    contextEngineFactory: (ws: Workspace) => new ContextEngine({ workspace: ws }),
    projectDir: dir,
    defaultAutonomy: 'workspace-write',
    defaultPolicy: 'never',
    defaultModel: { provider: 's', model: 'scripted-model' },
  });
  return { agents, bus, store, events };
}

describe('AgentRuntime', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forge-agent-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('loop drives real tools and completes with measured metrics', async () => {
    const ws = new Workspace({ root: dir });
    ws.writeFile('note.txt', 'hello');
    const { agents, events } = makeRuntime(dir, [
      { content: 'reading', toolCalls: [{ name: 'read_file', input: { path: 'note.txt' } }] },
      { content: 'editing', toolCalls: [{ name: 'edit_file', input: { path: 'note.txt', oldText: 'hello', newText: 'hello world' } }] },
      { content: 'All done. Updated note.txt.' },
    ]);
    const agent = agents.createAgent({ sessionId: sessionId(), name: 'worker', role: 'engineer' });
    const result = await agents.start(agent.id, 'Update note.txt to say hello world');
    assert.equal(result.state, 'completed');
    assert.equal(ws.readFile('note.txt'), 'hello world');
    assert.equal(result.toolCalls, 2);
    assert.equal(result.toolFailures, 0);
    assert.equal(result.filesChanged, 1);
    assert.ok(result.inputTokens > 0);
    assert.ok(events.some((e) => e.type === 'agent.completed'));
    assert.ok(events.some((e) => e.type === 'tool.completed'));
    // Transcript persisted for resume/observability.
    assert.ok(agents.get(agent.id).transcript.length > 0);
  });

  test('tool failures are observed and recoverable', async () => {
    const { agents } = makeRuntime(dir, [
      { content: 'trying', toolCalls: [{ name: 'read_file', input: { path: 'missing.txt' } }] },
      { content: 'The file does not exist, nothing to do.' },
    ]);
    const agent = agents.createAgent({ sessionId: sessionId(), name: 'worker' });
    const result = await agents.start(agent.id, 'Read missing.txt');
    assert.equal(result.state, 'completed');
    assert.equal(result.toolFailures, 1);
  });

  test('subagents inherit only the explicit delegation', async () => {
    const { agents } = makeRuntime(dir, [{ content: 'parent done' }]);
    const sess = sessionId();
    const parent = agents.createAgent({ sessionId: sess, name: 'parent' });
    await agents.start(parent.id, 'parent objective with SECRET-PARENT-CONTEXT');
    const child = agents.spawnSubagent(parent.id, { name: 'child', goal: 'child objective', parentSummary: 'brief summary' });
    assert.equal(child.parentAgentId, parent.id);
    assert.deepEqual(child.transcript.length, 1);
    assert.ok(!child.transcript[0]?.content.includes('SECRET-PARENT-CONTEXT'));
    assert.ok(child.transcript[0]?.content.includes('child objective'));
    assert.ok(agents.get(parent.id).children.includes(child.id));
  });

  test('agents exchange real messages', async () => {
    const { agents } = makeRuntime(dir, []);
    const sess = sessionId();
    const a = agents.createAgent({ sessionId: sess, name: 'a' });
    const b = agents.createAgent({ sessionId: sess, name: 'b' });
    agents.sendMessage(a.id, b.id, 'question', 'What is the API contract?', { subject: 'contract' });
    const inbox = agents.inbox(b.id);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.body, 'What is the API contract?');
    const waited = await agents.waitForMessage(b.id, { from: a.id, timeoutMs: 2000 });
    assert.equal(waited?.subject, 'contract');
  });

  test('pause on idle agent throws; cancel parks state', () => {
    const { agents } = makeRuntime(dir, []);
    const agent = agents.createAgent({ sessionId: sessionId(), name: 'w' });
    assert.throws(() => agents.pause(agent.id));
    agents.cancel(agent.id);
    assert.equal(agents.get(agent.id).state, 'cancelled');
  });
});
