import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemo } from '../demo.js';
import { SqliteStore } from '../store.js';

describe('demo mode', () => {
  test('scripted agents drive real tools to a green test suite', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'forge-demo-test-'));
    try {
      const eventTypes: string[] = [];
      let runTestsExit: number | undefined;
      let runTestsStdout = '';
      const { sessionId, teamId, taskIds, report } = await runDemo({
        workDir,
        onEvent: (e) => {
          eventTypes.push(e.type);
          if (e.type === 'tool.completed' && (e.data as { tool?: string }).tool === 'run_tests') {
            const r = (e.data as { result?: { exitCode?: number; stdout?: string } }).result;
            runTestsExit = r?.exitCode;
            runTestsStdout = r?.stdout ?? '';
          }
        },
      });
      assert.equal(report.state, 'completed');
      assert.equal(report.simulated, true);
      assert.equal(report.agents.length, 2);
      assert.ok(report.agents.every((a) => a.state === 'completed'));
      assert.equal(taskIds.length, 4);
      assert.ok(teamId.startsWith('team_'));

      // The fix is real: file on disk changed and tests genuinely pass.
      const fixed = readFileSync(join(workDir, 'src', 'checkout.js'), 'utf8');
      assert.ok(!fixed.includes('subtotal - discount - discount'));
      assert.ok(fixed.includes('return subtotal - discount;'));

      // Messages + events are real persisted runtime artifacts.
      const store = new SqliteStore({ path: join(workDir, '.forge', 'demo.db') });
      try {
        const msgs = store.loadMessages({ sessionId });
        assert.ok(msgs.length >= 2);
        const session = store.getDoc<{ simulated?: boolean }>('session', sessionId);
        assert.equal(session?.simulated, true);
      } finally {
        store.close();
      }
      assert.ok(eventTypes.includes('tool.completed'));
      assert.ok(eventTypes.includes('test.passed'));
      assert.ok(!eventTypes.includes('test.failed'));
      assert.equal(runTestsExit, 0);
      assert.match(runTestsStdout, /# pass 2/);
      assert.ok(eventTypes.includes('agent.message.sent'));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
