/**
 * Demo mode: a self-contained sample project with scripted agents driving
 * REAL tools (real file writes, real test execution, real git) in an
 * isolated temp directory. The session is flagged simulated and scripted
 * model output is marked simulated — the UI must render a DEMO banner.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForgeEvent } from './events.js';
import { ForgeRuntime, RunReport } from './runtime.js';
import { ScriptedProvider } from './providers.js';
import { runProcess } from './tools.js';
import { SessionId, TaskId, TeamId } from './ids.js';
import { AgentResult } from './agents.js';

const BUGGY_CHECKOUT = `// Sample checkout module (Forge demo project).
export function lineTotal(price, qty) {
  return price * qty;
}

export function orderTotal(lines, discount) {
  const subtotal = lines.reduce((n, l) => n + lineTotal(l.price, l.qty), 0);
  // BUG: discount is subtracted twice.
  return subtotal - discount - discount;
}
`;

const FIXED_CHECKOUT = `// Sample checkout module (Forge demo project).
export function lineTotal(price, qty) {
  return price * qty;
}

export function orderTotal(lines, discount) {
  const subtotal = lines.reduce((n, l) => n + lineTotal(l.price, l.qty), 0);
  return subtotal - discount;
}
`;

const CHECKOUT_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTotal, lineTotal } from '../src/checkout.js';

test('lineTotal multiplies price by quantity', () => {
  assert.equal(lineTotal(10, 3), 30);
});

test('orderTotal applies discount exactly once', () => {
  const lines = [{ price: 10, qty: 2 }, { price: 5, qty: 1 }];
  assert.equal(orderTotal(lines, 3), 22);
});
`;

const DEMO_AGENTS_MD = `# Demo project instructions

This is a Forge demo workspace. Conventions:

- Source lives in \`src/\`, tests in \`test/\` (node:test).
- Run tests with \`node --test "test/*.test.js"\`.
- Keep fixes minimal and verify with the test suite before finishing.
`;

const DEMO_PKG = JSON.stringify({ name: 'forge-demo-shop', version: '0.1.0', type: 'module', scripts: { test: 'node --test "test/*.test.js"' } }, null, 2);

export interface DemoResult {
  sessionId: SessionId;
  teamId: TeamId;
  taskIds: TaskId[];
  workDir: string;
  report: RunReport;
}

export async function scaffoldDemoProject(workDir: string): Promise<void> {
  mkdirSync(join(workDir, 'src'), { recursive: true });
  mkdirSync(join(workDir, 'test'), { recursive: true });
  writeFileSync(join(workDir, 'src', 'checkout.js'), BUGGY_CHECKOUT, 'utf8');
  writeFileSync(join(workDir, 'test', 'checkout.test.js'), CHECKOUT_TEST, 'utf8');
  writeFileSync(join(workDir, 'AGENTS.md'), DEMO_AGENTS_MD, 'utf8');
  writeFileSync(join(workDir, 'package.json'), DEMO_PKG, 'utf8');
  // Real git history so git tools/diffs work in the demo.
  try {
    await runProcess('git', ['init'], { cwd: workDir, timeoutMs: 15_000 });
    await runProcess('git', ['add', '-A'], { cwd: workDir, timeoutMs: 15_000 });
    await runProcess('git', ['-c', 'user.email=demo@forge.dev', '-c', 'user.name=Forge Demo', 'commit', '-m', 'demo: initial buggy checkout'], { cwd: workDir, timeoutMs: 15_000 });
  } catch {
    // git unavailable — demo still works; git tools will report honestly.
  }
}

export async function runDemo(opts?: { workDir?: string; onEvent?: (e: ForgeEvent) => void }): Promise<DemoResult> {
  const workDir = opts?.workDir ?? mkdtempSync(join(tmpdir(), 'forge-demo-'));
  await scaffoldDemoProject(workDir);

  const oldLine = '  // BUG: discount is subtracted twice.\n  return subtotal - discount - discount;';
  const newLine = '  return subtotal - discount;';
  if (!BUGGY_CHECKOUT.includes(oldLine) || !FIXED_CHECKOUT.includes(newLine)) {
    throw new Error('demo scaffold drift: fix script does not match scaffolded content');
  }

  const scripted = new ScriptedProvider({
    id: 'demo-script',
    script: [
      // --- Builder turns ---
      { content: 'I will inspect the failing checkout module first.', toolCalls: [{ name: 'read_file', input: { path: 'src/checkout.js' } }] },
      {
        content: 'Found it: the discount is subtracted twice. Applying a minimal fix.',
        toolCalls: [{ name: 'edit_file', input: { path: 'src/checkout.js', oldText: oldLine, newText: newLine } }],
      },
      { content: 'Fix applied. Running the test suite to verify.', toolCalls: [{ name: 'run_tests', input: {} }] },
      {
        content: 'Tests pass. Reporting progress and notifying the reviewer.',
        toolCalls: [
          { name: 'report_progress', input: { progress: 90, currentAction: 'fix verified, awaiting review' } },
          { name: 'send_message', input: { to: 'reviewer', type: 'request', subject: 'Review checkout fix', body: 'Fixed the double-discount bug in src/checkout.js. Tests pass. Please review.' } },
        ],
      },
      { content: 'Checkout fix complete: removed the duplicate discount subtraction in orderTotal. Test suite passes (2/2).' },
      // --- Reviewer turns ---
      { content: 'Reviewing the fix now.', toolCalls: [{ name: 'read_file', input: { path: 'src/checkout.js' } }] },
      {
        content: 'The change is minimal and correct. Sending approval.',
        toolCalls: [{ name: 'send_message', input: { to: 'builder', type: 'response', subject: 'Approved', body: 'Approved. Minimal diff, tests green.' } }],
      },
      { content: 'Review complete: approved. The diff removes the duplicate subtraction and nothing else.' },
    ],
  });

  const runtime = await ForgeRuntime.create({
    projectDir: workDir,
    storePath: join(workDir, '.forge', 'demo.db'),
    providers: [scripted],
    allowSimulatedFallback: false,
  });
  if (opts?.onEvent) runtime.bus.subscribe(() => true, opts.onEvent);

  const session = runtime.sessions.create({ name: 'demo: checkout fix', projectDir: workDir, simulated: true });
  const team = runtime.teams.create({ sessionId: session.id, name: 'demo-team', sharedGoal: 'Fix the failing checkout tests.' });
  runtime.sessions.attach(session.id, { teamId: team.id });

  const tInspect = runtime.scheduler.create({ sessionId: session.id, title: 'Inspect checkout module', description: 'Read src/checkout.js and identify the bug.', teamId: team.id });
  const tFix = runtime.scheduler.create({ sessionId: session.id, title: 'Fix double discount', description: 'Remove the duplicate discount subtraction.', dependsOn: [tInspect.id], teamId: team.id });
  const tTest = runtime.scheduler.create({ sessionId: session.id, title: 'Run checkout tests', description: 'node --test "test/*.test.js"', dependsOn: [tFix.id], teamId: team.id });
  const tReview = runtime.scheduler.create({ sessionId: session.id, title: 'Review fix', description: 'Independent review of the diff.', dependsOn: [tTest.id], teamId: team.id });
  for (const t of [tInspect, tFix, tTest, tReview]) {
    runtime.teams.enqueueTask(team.id, t.id);
    runtime.sessions.attach(session.id, { taskId: t.id });
  }

  const builder = runtime.agents.createAgent({ sessionId: session.id, name: 'builder', role: 'Backend Engineer', model: { provider: 'demo-script', model: 'scripted-model' } });
  const reviewer = runtime.agents.createAgent({ sessionId: session.id, name: 'reviewer', role: 'Reviewer', model: { provider: 'demo-script', model: 'scripted-model' } });
  runtime.teams.addMember(team.id, builder.id, 'Backend Engineer');
  runtime.teams.addMember(team.id, reviewer.id, 'Reviewer');
  runtime.sessions.attach(session.id, { agentId: builder.id });
  runtime.sessions.attach(session.id, { agentId: reviewer.id });
  runtime.scheduler.setOwner(tFix.id, builder.id);
  runtime.scheduler.setOwner(tReview.id, reviewer.id);

  const builderResult: AgentResult = await runtime.agents.start(builder.id, 'Fix the failing checkout tests in this repository. Keep the change minimal and verify with the test suite.', { taskId: tFix.id, maxIterations: 8 });
  for (const t of [tInspect, tFix, tTest]) {
    const cur = runtime.scheduler.get(t.id);
    if (builderResult.state === 'completed' && (cur.status === 'pending' || cur.status === 'ready')) {
      cur.status = 'completed';
      cur.progress = 100;
      cur.completedAt = new Date().toISOString();
      cur.updatedAt = cur.completedAt;
      runtime.store.putDoc('task', cur.id, cur.sessionId, cur.updatedAt, cur);
    }
  }
  const reviewerResult: AgentResult = await runtime.agents.start(reviewer.id, 'Review the checkout fix for correctness and minimality. Read the fixed file and approve or request changes via message.', { taskId: tReview.id, maxIterations: 6 });
  if (reviewerResult.state === 'completed') {
    const cur = runtime.scheduler.get(tReview.id);
    cur.status = 'completed';
    cur.progress = 100;
    cur.completedAt = new Date().toISOString();
    cur.updatedAt = cur.completedAt;
    runtime.store.putDoc('task', cur.id, cur.sessionId, cur.updatedAt, cur);
  }

  const report: RunReport = {
    sessionId: session.id,
    teamId: team.id,
    taskIds: [tInspect.id, tFix.id, tTest.id, tReview.id],
    state: 'completed',
    agents: [builderResult, reviewerResult],
    filesChanged: ['src/checkout.js'],
    inputTokens: builderResult.inputTokens + reviewerResult.inputTokens,
    outputTokens: builderResult.outputTokens + reviewerResult.outputTokens,
    summary: `DEMO — ${builderResult.summary}\n\nDEMO — ${reviewerResult.summary}`,
    simulated: true,
  };
  return { sessionId: session.id, teamId: team.id, taskIds: report.taskIds, workDir, report };
}
