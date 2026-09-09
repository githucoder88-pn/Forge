import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../router.js';
import { ScriptedProvider } from '../providers.js';
import { ForgeError } from '../errors.js';
import { EventBus } from '../events.js';

describe('ModelRouter', () => {
  test('throws NO_PROVIDER when nothing is registered', async () => {
    const router = new ModelRouter();
    await assert.rejects(() => router.route({}), (e: unknown) => e instanceof ForgeError && e.code === 'NO_PROVIDER');
  });

  test('routes to the preferred provider (manual)', async () => {
    const router = new ModelRouter();
    router.registerProvider(new ScriptedProvider({ id: 'a', script: [] }));
    router.registerProvider(new ScriptedProvider({ id: 'b', script: [] }));
    const d = await router.route({ strategy: 'manual', preferred: { provider: 'b', model: 'm' } });
    assert.equal(d.providerId, 'b');
    assert.equal(d.model, 'm');
  });

  test('falls back across the chain on failure', async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe(() => true, (e) => { events.push(e.type); });
    const router = new ModelRouter({ bus, maxRetries: 0 });
    router.registerProvider(new ScriptedProvider({
      id: 'primary',
      script: [{ error: new ForgeError('PROVIDER_ERROR', 'primary down') }],
    }));
    router.registerProvider(new ScriptedProvider({ id: 'backup', script: [{ content: 'recovered' }] }));
    const res = await router.chat(
      { strategy: 'priority' },
      { messages: [{ role: 'user', content: 'hi' }], model: 'm' },
    );
    assert.equal(res.content, 'recovered');
    assert.equal(res.provider, 'backup');
    assert.ok(events.includes('model.fallback'));
    assert.ok(events.includes('model.failed'));
  });

  test('retries with backoff then succeeds', async () => {
    const router = new ModelRouter({ maxRetries: 2, baseBackoffMs: 5 });
    router.registerProvider(new ScriptedProvider({
      id: 'flaky',
      script: [
        { error: new ForgeError('PROVIDER_ERROR', 'blip') },
        { content: 'second try works' },
      ],
    }));
    const res = await router.chat({}, { messages: [], model: 'm' });
    assert.equal(res.content, 'second try works');
  });

  test('circuit opens after repeated failures', async () => {
    const router = new ModelRouter({ maxRetries: 0, fallbackEnabled: false });
    router.registerProvider(new ScriptedProvider({
      id: 'bad',
      script: Array.from({ length: 10 }, () => ({ error: new ForgeError('PROVIDER_ERROR', 'down') })),
    }));
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => router.chat({}, { messages: [], model: 'm' }));
    }
    assert.equal(router.getHealth('bad'), 'offline');
    const stats = router.stats();
    assert.equal(stats.bad?.consecutiveFailures, 5);
  });

  test('accounts tokens per provider', async () => {
    const router = new ModelRouter();
    const p = new ScriptedProvider({ id: 's', script: [{ content: 'hello world this is a test' }] });
    router.registerProvider(p);
    await router.chat({}, { messages: [{ role: 'user', content: 'hi there friend' }], model: 'm' });
    const stats = router.stats();
    assert.equal(stats.s?.requests, 1);
    assert.ok((stats.s?.tokensIn ?? 0) > 0);
    assert.ok((stats.s?.tokensOut ?? 0) > 0);
  });
});
