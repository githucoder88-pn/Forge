#!/usr/bin/env node
/**
 * Forge CLI. `serve`/`run`/`plan`/`demo` run an embedded Core; everything
 * else talks to a server over the versioned protocol (default: local).
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ForgeError, ForgeRuntime, globalConfigDir, loadConfig, applySessionOverrides,
  type EventBus, type ForgeEvent, type ForgeConfig,
} from '@forge/core';
import { ForgeServer, DEFAULT_PORT, tokenFilePath } from '@forge/server';
import { ForgeClient, ForgeClientError, type ForgeEventDTO } from '@forge/protocol-client';
import { CliError, flag, flagBool, flagList, parseArgs, requirePositional, type ParsedArgs } from './args.js';
import { C, fmtTime, printJson, setColor, shortId, stateColored, table } from './format.js';

const VERSION = '0.1.0';

const HELP = `
Forge ${VERSION} — open-source AI engineering platform

Usage: forge <command> [subcommand] [args] [--flags]

Embedded (no server needed):
  serve                   Start the Core server (API + events + web client)
  run "<goal>"            Run an agent on a goal (streams live progress)
  plan "<goal>"           Print a task graph for a goal (no execution)
  demo                    Run the scripted end-to-end demo (SIMULATED models, real tools)

Server-backed (talk to forge serve):
  status                  Runtime overview: sessions, agents, tasks, providers
  agents [list|inspect|pause|resume|cancel|retry|spawn]
  tasks [list|inspect|create|update|cancel|pause|resume|retry|run]
  teams [list|inspect|create|add|remove|status]
  message [send|inbox|log]
  model [status|refresh|route]
  checkpoint [create|list|restore|rollback]
  approvals [list|resolve]
  memory [put|get|list|search|delete]
  session [list|inspect|resume|close]
  tool [list|invoke]
  watch                   Stream live events
  logs                    Show persisted events
  review                  Run a reviewer over current changes
  config                  Show effective configuration (secrets redacted)

Global flags:
  --url <url>             Server URL (default http://127.0.0.1:8719)
  --project <dir>         Project directory (default: cwd)
  --token <token>         Auth token (default: token file / FORGE_TOKEN)
  --json                  Machine-readable output
  --no-color              Disable colors
  --help, --version

Examples:
  forge serve --port 8719
  forge run "Fix the failing checkout tests" --plan
  forge run "Refactor auth" --team eng:backend,frontend,qa
  forge tasks --session sess_abc123
  forge watch --session sess_abc123
  forge approvals resolve appr_x --approve
`.trim();

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (flagBool(args, 'no-color') || process.env.NO_COLOR) setColor(false);
  try {
    if (flagBool(args, 'version') || args.command === 'version') {
      console.log(`forge ${VERSION}`);
      return 0;
    }
    if (!args.command || flagBool(args, 'help') || args.command === 'help') {
      console.log(HELP);
      return 0;
    }
    switch (args.command) {
      case 'serve': return await cmdServe(args);
      case 'run': return await cmdRun(args);
      case 'plan': return await cmdPlan(args);
      case 'demo': return await cmdDemo(args);
      case 'status': return await cmdStatus(args);
      case 'agents': return await cmdAgents(args);
      case 'tasks': return await cmdTasks(args);
      case 'teams': return await cmdTeams(args);
      case 'message': return await cmdMessage(args);
      case 'model': return await cmdModel(args);
      case 'checkpoint': return await cmdCheckpoint(args);
      case 'approvals': return await cmdApprovals(args);
      case 'memory': return await cmdMemory(args);
      case 'session': return await cmdSession(args);
      case 'tool': return await cmdTool(args);
      case 'watch': return await cmdWatch(args);
      case 'logs': return await cmdLogs(args);
      case 'review': return await cmdReview(args);
      case 'config': return await cmdConfig(args);
      default:
        throw new CliError(`Unknown command '${args.command}'. See 'forge --help'.`);
    }
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`forge: ${e.message}`);
      return 2;
    }
    if (e instanceof ForgeClientError) {
      console.error(`forge: ${e.message}`);
      if (e.code === -1) console.error('hint: is the server running? (forge serve)');
      return 1;
    }
    if (e instanceof ForgeError) {
      console.error(`forge: [${e.code}] ${e.message}`);
      return 1;
    }
    console.error(`forge: ${(e as Error).message}`);
    return 1;
  }
}

// ------------------------------------------------------------------ shared ---

function serverUrl(args: ParsedArgs): string {
  return flag(args, 'url') ?? process.env.FORGE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;
}

function projectDir(args: ParsedArgs): string {
  return resolve(flag(args, 'project') ?? process.env.FORGE_PROJECT ?? process.cwd());
}

function authToken(args: ParsedArgs): string | undefined {
  const explicit = flag(args, 'token') ?? process.env.FORGE_TOKEN;
  if (explicit) return explicit;
  try {
    const path = tokenFilePath();
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  } catch { /* no token file */ }
  return undefined;
}

function makeClient(args: ParsedArgs): ForgeClient {
  return new ForgeClient({ url: serverUrl(args), token: authToken(args) });
}

function wantJson(args: ParsedArgs): boolean {
  return flagBool(args, 'json');
}

function parseModelRef(raw: string | undefined): { provider: string; model: string } | undefined {
  if (!raw) return undefined;
  const i = raw.indexOf(':');
  if (i <= 0) throw new CliError(`--model must be provider:model (got '${raw}')`);
  return { provider: raw.slice(0, i), model: raw.slice(i + 1) };
}

async function createEmbedded(args: ParsedArgs, extra?: { allowSimulatedFallback?: boolean; storePath?: string }): Promise<ForgeRuntime> {
  const dir = projectDir(args);
  const { config: fileConfig } = loadConfig(dir);
  const overrides: Partial<ForgeConfig> = {};
  const autonomy = flag(args, 'autonomy');
  if (autonomy) overrides.autonomy = { default: autonomy as never };
  const policy = flag(args, 'policy');
  if (policy) overrides.autonomy = { ...(overrides.autonomy ?? {}), approvalPolicy: policy as never };
  const strategy = flag(args, 'strategy');
  if (strategy) overrides.routing = { strategy: strategy as never };
  const model = parseModelRef(flag(args, 'model'));
  if (model) overrides.models = { primary: model };
  const config = applySessionOverrides(fileConfig, overrides);
  const rt = await ForgeRuntime.create({
    projectDir: dir,
    config,
    storePath: flag(args, 'store') ?? extra?.storePath,
    allowSimulatedFallback: extra?.allowSimulatedFallback ?? false,
    pluginsDir: flag(args, 'plugins') ?? process.env.FORGE_PLUGINS,
  });
  wireInteractiveApprovals(rt, args);
  return rt;
}

function wireInteractiveApprovals(rt: ForgeRuntime, args: ParsedArgs): void {
  const nonInteractive = flagBool(args, 'non-interactive') || flagBool(args, 'yes') || !process.stdin.isTTY;
  rt.bus.subscribe({ types: ['approval.requested'] }, (e) => {
    const data = e.data as { id?: string; summary?: string; risk?: string };
    const pending = rt.gate.listPending();
    const match = pending.find((x) => x.id === data.id) ?? pending[pending.length - 1];
    if (!match) return;
    if (nonInteractive) {
      console.error(`${C.yellow('[approval]')} ${match.summary} [${match.risk}] → denied (non-interactive)`);
      rt.gate.resolve(match.id, false);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${C.yellow('[approval]')} ${match.summary} [risk: ${match.risk}] — approve? [y/N] `, (answer) => {
      rl.close();
      const approved = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
      try {
        rt.gate.resolve(match.id, approved);
      } catch { /* already settled */ }
    });
  });
}

interface StreamStats {
  toolCalls: number;
  toolFailures: number;
  filesChanged: number;
  modelFallbacks: number;
  inputTokens: number;
  outputTokens: number;
}

function streamEvents(bus: EventBus, opts?: { verbose?: boolean; sessionId?: string }): { stop: () => void; stats: StreamStats } {
  const stats: StreamStats = { toolCalls: 0, toolFailures: 0, filesChanged: 0, modelFallbacks: 0, inputTokens: 0, outputTokens: 0 };
  const verbose = opts?.verbose ?? false;
  const stop = bus.subscribe(() => true, (e: ForgeEvent) => {
    if (opts?.sessionId && e.sessionId !== opts.sessionId) return;
    const t = fmtTime(e.ts);
    const sim = e.simulated ? C.yellow('[sim] ') : '';
    const d = e.data as Record<string, unknown>;
    switch (e.type) {
      case 'agent.started':
        console.log(`${C.dim(t)} ${sim}${C.bold('agent started')} ${String(d.goal ?? '').slice(0, 120)}`);
        break;
      case 'agent.action':
        console.log(`${C.dim(t)} ${sim}▸ ${String(d.action ?? '')}`);
        break;
      case 'agent.progress': {
        const pct = typeof d.progress === 'number' ? `${d.progress}% ` : '';
        console.log(`${C.dim(t)} ${sim}${C.green('progress')} ${pct}${String(d.currentAction ?? d.note ?? '')}`);
        break;
      }
      case 'agent.completed':
        console.log(`${C.dim(t)} ${sim}${C.green('agent completed')} ${(e.agentId ?? '').slice(0, 18)}`);
        break;
      case 'agent.failed':
        console.log(`${C.dim(t)} ${sim}${C.red('agent failed')} ${JSON.stringify((d.error as { message?: string } | undefined)?.message ?? d)}`);
        break;
      case 'agent.blocked':
        console.log(`${C.dim(t)} ${sim}${C.red('agent blocked')} ${String(d.reason ?? '')}`);
        break;
      case 'tool.completed':
        stats.toolCalls++;
        if (verbose) console.log(`${C.dim(t)} ${sim}  ✓ ${String(d.tool)} (${String(d.durationMs)}ms)`);
        break;
      case 'tool.failed':
        stats.toolCalls++;
        stats.toolFailures++;
        console.log(`${C.dim(t)} ${sim}  ${C.red('✗')} ${String(d.tool)}: ${JSON.stringify((d.error as { message?: string } | undefined)?.message ?? d).slice(0, 300)}`);
        break;
      case 'file.created':
      case 'file.modified':
      case 'file.deleted':
        stats.filesChanged++;
        console.log(`${C.dim(t)} ${sim}  ${e.type === 'file.deleted' ? C.red('D') : C.green('M')} ${String(d.path)}`);
        break;
      case 'model.fallback':
        stats.modelFallbacks++;
        console.log(`${C.dim(t)} ${C.yellow('model fallback')} ${JSON.stringify(d.to)} (${String((d.previousError as string) ?? '').slice(0, 160)})`);
        break;
      case 'model.completed': {
        const u = d.usage as { inputTokens?: number; outputTokens?: number } | undefined;
        stats.inputTokens += u?.inputTokens ?? 0;
        stats.outputTokens += u?.outputTokens ?? 0;
        break;
      }
      case 'test.passed':
        console.log(`${C.dim(t)} ${C.green('tests passed')} ${String(d.command ?? '')}`);
        break;
      case 'test.failed':
        console.log(`${C.dim(t)} ${C.red('tests failed')} ${String(d.command ?? '')} (exit ${String(d.exitCode)})`);
        break;
      case 'task.completed':
        console.log(`${C.dim(t)} ${C.green('task done')} ${(e.taskId ?? '').slice(0, 18)}`);
        break;
      case 'task.failed':
        console.log(`${C.dim(t)} ${C.red('task failed')} ${(e.taskId ?? '').slice(0, 18)}`);
        break;
      case 'agent.message.sent': {
        const body = String((d.body as string) ?? '').slice(0, 200).replace(/\n/g, ' ');
        console.log(`${C.dim(t)} ${sim}${C.bold('msg')} ${String(d.from ?? '').slice(0, 14)} → ${String(d.to ?? '').slice(0, 14)}: ${body}`);
        break;
      }
      case 'runtime.warning':
        console.log(`${C.dim(t)} ${C.yellow('warning')} ${String(d.message ?? '')}`);
        break;
      case 'runtime.error':
        console.log(`${C.dim(t)} ${C.red('error')} ${String(d.message ?? '')}`);
        break;
      case 'approval.requested':
        console.log(`${C.dim(t)} ${C.yellow('approval requested')} ${String(d.summary ?? '').slice(0, 160)} [${String(d.risk)}]`);
        break;
      case 'checkpoint.created':
        console.log(`${C.dim(t)} checkpoint ${String(d.label ?? d.checkpointId)}`);
        break;
      default:
        if (verbose) console.log(`${C.dim(t)} ${C.dim(e.type)}`);
        break;
    }
  });
  return { stop, stats };
}

// ------------------------------------------------------------------- serve ---

function resolveClientDirs(): { webDir?: string; clientDistDir?: string } {
  const here = dirname(fileURLToPath(import.meta.url)); // packages/forge-cli/dist
  const candidates = [
    process.env.FORGE_WEB_DIR,
    resolve(here, '../../../apps/forge-web/public'),
    resolve(here, '../../apps/forge-web/public'),
  ].filter(Boolean) as string[];
  const webDir = candidates.find((d) => existsSync(join(d, 'index.html')));
  const clientCandidates = [
    process.env.FORGE_CLIENT_DIST,
    resolve(here, '../../protocol-client/dist'),
    resolve(here, '../../../packages/protocol-client/dist'),
    resolve(here, '../node_modules/@forge/protocol-client/dist'),
  ].filter(Boolean) as string[];
  const clientDistDir = clientCandidates.find((d) => existsSync(join(d, 'index.js')));
  return { webDir, clientDistDir };
}

async function cmdServe(args: ParsedArgs): Promise<number> {
  const port = Number(flag(args, 'port') ?? process.env.FORGE_PORT ?? DEFAULT_PORT);
  const host = flag(args, 'host') ?? process.env.FORGE_HOST ?? '127.0.0.1';
  const rt = await createEmbedded(args);
  const { webDir, clientDistDir } = resolveClientDirs();
  const server = new ForgeServer({
    runtime: rt, port, host,
    token: flag(args, 'token') ?? process.env.FORGE_TOKEN,
    requireAuth: flagBool(args, 'require-auth'),
    webDir, clientDistDir,
  });
  const { stop, stats } = streamEvents(rt.bus, { verbose: flagBool(args, 'verbose') });
  const { url } = await server.start();
  console.log(`forge server ${VERSION}`);
  console.log(`  url:        ${url}`);
  console.log(`  web client: ${webDir ? url + '/app/' : '(not built — run npm run build)'}`);
  console.log(`  project:    ${rt.projectDir}`);
  console.log(`  providers:  ${rt.router.providerIds().join(', ') || '(none configured)'}`);
  if (server.tokenCreated) {
    console.log(`  token:      created at ${tokenFilePath()} (required for non-loopback access)`);
  }
  console.log('Press Ctrl+C to stop.');
  await new Promise<void>((resolvePromise) => {
    const shutdown = async (): Promise<void> => {
      console.log('\nShutting down…');
      stop();
      await server.stop();
      await rt.shutdown();
      console.log(`session stats: ${stats.toolCalls} tool calls (${stats.toolFailures} failed), ${stats.filesChanged} file changes, ${stats.inputTokens + stats.outputTokens} tokens`);
      resolvePromise();
    };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
  });
  return 0;
}

// --------------------------------------------------------------------- run ---

async function cmdRun(args: ParsedArgs): Promise<number> {
  const goal = [args.sub, ...args.positional].filter(Boolean).join(' ');
  if (!goal) throw new CliError('Missing a goal string. Usage: forge run "<goal>"');
  const rt = await createEmbedded(args);
  const { stop, stats } = streamEvents(rt.bus, { verbose: flagBool(args, 'verbose') });
  try {
    const teamRaw = flag(args, 'team');
    let team: { name: string; roles: string[] } | undefined;
    if (teamRaw) {
      const [name, roles] = teamRaw.includes(':') ? teamRaw.split(':') as [string, string] : ['engineering', teamRaw];
      team = { name, roles: roles.split(',').map((s) => s.trim()).filter(Boolean) };
    }
    const report = await rt.runGoal(goal, {
      agentName: flag(args, 'agent'),
      role: flag(args, 'role'),
      model: parseModelRef(flag(args, 'model')),
      maxIterations: flag(args, 'max-iterations') ? Number(flag(args, 'max-iterations')) : undefined,
      enhance: flagBool(args, 'enhance'),
      plan: flagBool(args, 'plan'),
      team,
      sessionId: flag(args, 'session') as never,
    });
    stop();
    console.log('');
    if (wantJson(args)) {
      printJson(report);
    } else {
      console.log(C.bold(`Run ${report.state}`) + (report.simulated ? ` ${C.yellow('[SIMULATED models]')}` : ''));
      console.log(`  session:  ${report.sessionId}`);
      if (report.agentId) console.log(`  agent:    ${report.agentId}`);
      if (report.teamId) console.log(`  team:     ${report.teamId}`);
      console.log(`  tasks:    ${report.taskIds.length}`);
      console.log(`  files:    ${report.filesChanged.length > 0 ? report.filesChanged.join(', ') : '(none)'}`);
      console.log(`  tokens:   ${report.inputTokens} in / ${report.outputTokens} out`);
      console.log(`  tools:    ${stats.toolCalls} calls, ${stats.toolFailures} failed, ${stats.modelFallbacks} fallbacks`);
      console.log('');
      console.log(report.summary);
    }
    await rt.shutdown();
    return report.state === 'completed' ? 0 : 1;
  } catch (e) {
    stop();
    await rt.shutdown();
    throw e;
  }
}

async function cmdPlan(args: ParsedArgs): Promise<number> {
  const goal = [args.sub, ...args.positional].filter(Boolean).join(' ');
  if (!goal) throw new CliError('Missing a goal string. Usage: forge plan "<goal>"');
  const rt = await createEmbedded(args);
  try {
    const session = rt.ensureSession();
    const tasks = await rt.planGoal(session.id, goal, { maxTasks: flag(args, 'max-tasks') ? Number(flag(args, 'max-tasks')) : undefined });
    if (wantJson(args)) {
      printJson(tasks);
    } else {
      console.log(`Plan for session ${session.id}:`);
      console.log(table(
        ['id', 'title', 'depends on', 'status'],
        tasks.map((t) => [shortId(t.id), t.title.slice(0, 50), t.dependsOn.map(shortId).join(', ') || '-', t.status]),
      ));
    }
    await rt.shutdown();
    return 0;
  } catch (e) {
    await rt.shutdown();
    throw e;
  }
}

async function cmdDemo(args: ParsedArgs): Promise<number> {
  const { runDemo } = await import('@forge/core');
  const demo = await runDemo({
    workDir: flag(args, 'dir'),
    onEvent: (e) => {
      const d = e.data as Record<string, unknown>;
      const sim = C.yellow('[sim] ');
      if (e.type === 'agent.action') console.log(`  ${sim}▸ ${String(d.action ?? '')}`);
      else if (e.type === 'file.modified' || e.type === 'file.created') console.log(`  ${sim}${C.green('M')} ${String(d.path)}`);
      else if (e.type === 'test.passed') console.log(`  ${sim}${C.green('tests passed')}`);
      else if (e.type === 'test.failed') console.log(`  ${sim}${C.red('tests failed')}`);
      else if (e.type === 'agent.message.sent') console.log(`  ${sim}${C.bold('msg')} ${String(d.from ?? '').slice(0, 12)} → ${String(d.to ?? '').slice(0, 12)}: ${String(d.body ?? '').slice(0, 120)}`);
      else if (e.type === 'agent.completed') console.log(`  ${sim}${C.green('agent completed')}`);
    },
  });
  if (wantJson(args)) {
    printJson(demo.report);
  } else {
    console.log('');
    console.log(C.bold('Demo complete [SIMULATED models, REAL tools]'));
    console.log(`  workspace: ${demo.workDir}`);
    console.log(`  session:   ${demo.sessionId}`);
    console.log(`  team:      ${demo.teamId}`);
    console.log(`  tasks:     ${demo.taskIds.length}`);
    console.log('');
    console.log(demo.report.summary);
  }
  return 0;
}

// ------------------------------------------------------------ server-backed ---

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const [status, agents, tasks, sessions] = await Promise.all([
    c.runtimeStatus() as Promise<{ projectDir: string; sessions: number; agents: number; providers: { providers: Record<string, { health: string; requests: number; tokensIn: number; tokensOut: number }> }; approvals: number; eventSeq: number }>,
    c.agentList(flag(args, 'session')),
    c.taskList(flag(args, 'session')),
    c.sessionList(),
  ]);
  if (wantJson(args)) {
    printJson({ status, agents, tasks, sessions });
    return 0;
  }
  console.log(C.bold('Forge status'));
  console.log(`  project:   ${status.projectDir}`);
  console.log(`  sessions:  ${status.sessions}   agents: ${agents.length}   tasks: ${tasks.length}   pending approvals: ${status.approvals}`);
  console.log('');
  console.log(C.bold('Providers'));
  const rows = Object.entries(status.providers.providers).map(([id, p]) =>
    [id, stateColored(p.health), String(p.requests), `${p.tokensIn}/${p.tokensOut}`]);
  console.log(rows.length > 0 ? table(['provider', 'health', 'reqs', 'tok in/out'], rows) : '  (none configured)');
  if (agents.length > 0) {
    console.log('');
    console.log(C.bold('Agents'));
    console.log(table(
      ['id', 'name', 'role', 'state', 'progress', 'task'],
      agents.map((a) => [shortId(a.id), a.name, a.role, stateColored(a.state), a.progress === null ? '-' : `${a.progress}%`, a.currentTaskId ? shortId(a.currentTaskId) : '-']),
    ));
  }
  if (tasks.length > 0) {
    console.log('');
    console.log(C.bold('Tasks'));
    console.log(table(
      ['id', 'title', 'status', 'owner', 'depends on'],
      tasks.map((t) => [shortId(t.id), t.title.slice(0, 40), stateColored(t.status), t.ownerAgentId ? shortId(t.ownerAgentId) : '-', t.dependsOn.map(shortId).join(',') || '-']),
    ));
  }
  void sessions;
  return 0;
}

async function cmdAgents(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sub = args.sub ?? 'list';
  if (sub === 'list' || sub === undefined) {
    const agents = await c.agentList(flag(args, 'session'));
    if (wantJson(args)) { printJson(agents); return 0; }
    if (agents.length === 0) {
      console.log('No agents running.\n\nCreate one with: forge agents spawn --help (server) or forge run "<goal>" (embedded)');
      return 0;
    }
    console.log(table(
      ['id', 'name', 'role', 'state', 'progress', 'action', 'tokens'],
      agents.map((a) => [
        shortId(a.id), a.name, a.role, stateColored(a.state),
        a.progress === null ? '-' : `${a.progress}%`,
        (a.currentAction ?? '').slice(0, 40),
        `${(a.metrics.inputTokens as number) ?? 0}/${(a.metrics.outputTokens as number) ?? 0}`,
      ]),
    ));
    return 0;
  }
  if (sub === 'inspect') {
    const a = await c.agentGet(requirePositional(args, 0, 'agent id'));
    if (wantJson(args)) { printJson(a); return 0; }
    console.log(C.bold(`${a.name} (${a.role})`));
    console.log(`  id:       ${a.id}`);
    console.log(`  state:    ${stateColored(a.state)}`);
    console.log(`  model:    ${a.model ? `${a.model.provider}:${a.model.model}` : '(routed)'}`);
    console.log(`  task:     ${a.currentTaskId ?? '-'}`);
    console.log(`  progress: ${a.progress === null ? 'unknown' : `${a.progress}%`}`);
    console.log(`  action:   ${a.currentAction ?? '-'}`);
    console.log(`  metrics:  ${JSON.stringify(a.metrics)}`);
    if (a.plan.length > 0) {
      console.log('  plan:');
      for (const s of a.plan) console.log(`    [${s.done ? 'x' : ' '}] ${s.title}`);
    }
    if (a.lastError) console.log(`  error:    ${C.red(a.lastError)}`);
    return 0;
  }
  if (sub === 'pause' || sub === 'resume' || sub === 'cancel') {
    const id = requirePositional(args, 0, 'agent id');
    const a = sub === 'pause' ? await c.agentPause(id) : sub === 'resume' ? await c.agentResume(id) : await c.agentCancel(id);
    console.log(`${shortId(a.id)} → ${stateColored(a.state)}`);
    return 0;
  }
  if (sub === 'retry') {
    const id = requirePositional(args, 0, 'agent id');
    await c.rpc('agent.retry', { agentId: id });
    console.log(`${shortId(id)} retry accepted (watch with: forge watch)`);
    return 0;
  }
  if (sub === 'spawn') {
    const parent = requirePositional(args, 0, 'parent agent id');
    const child = await c.agentSpawn(parent, {
      name: flag(args, 'name') ?? 'subagent',
      goal: flag(args, 'goal') ?? requirePositional(args, 1, '--goal'),
      role: flag(args, 'role'),
    });
    console.log(`spawned ${shortId(child.id)} (${child.name})`);
    return 0;
  }
  throw new CliError(`Unknown agents subcommand '${sub}'.`);
}

async function cmdTasks(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sub = args.sub ?? 'list';
  if (sub === 'list' || sub === undefined) {
    const tasks = await c.taskList(flag(args, 'session'));
    if (wantJson(args)) { printJson(tasks); return 0; }
    if (tasks.length === 0) {
      console.log('No tasks.\n\n[Create Task: forge tasks create --session <id> --title "..."]');
      return 0;
    }
    console.log(table(
      ['id', 'title', 'status', 'owner', 'progress', 'depends on'],
      tasks.map((t) => [shortId(t.id), t.title.slice(0, 42), stateColored(t.status), t.ownerAgentId ? shortId(t.ownerAgentId) : '-', t.progress === null ? '-' : `${t.progress}%`, t.dependsOn.map(shortId).join(',') || '-']),
    ));
    return 0;
  }
  if (sub === 'inspect') {
    const t = await c.taskGet(requirePositional(args, 0, 'task id'));
    if (wantJson(args)) { printJson(t); return 0; }
    console.log(C.bold(t.title));
    console.log(`  id:       ${t.id}`);
    console.log(`  status:   ${stateColored(t.status)}`);
    console.log(`  owner:    ${t.ownerAgentId ?? '-'}`);
    console.log(`  depends:  ${t.dependsOn.join(', ') || '-'}`);
    console.log(`  retries:  ${t.retries}/${t.maxRetries}`);
    if (t.description) console.log(`  desc:     ${t.description.slice(0, 500)}`);
    if (t.blockedBy) console.log(`  blocked:  ${C.red(t.blockedBy)}`);
    for (const e of t.errors) console.log(`  error:    ${C.red(e.message.slice(0, 300))}`);
    if (t.artifacts.length > 0) console.log(`  artifacts: ${t.artifacts.join(', ')}`);
    return 0;
  }
  if (sub === 'create') {
    const sessionId = flag(args, 'session') ?? (await c.sessionList())[0]?.id;
    if (!sessionId) throw new CliError('No session. Pass --session <id>.');
    const t = await c.taskCreate({
      sessionId,
      title: flag(args, 'title') ?? requirePositional(args, 0, 'a --title'),
      description: flag(args, 'description'),
      dependsOn: flagList(args, 'depends'),
      priority: flag(args, 'priority') ? Number(flag(args, 'priority')) : undefined,
      ownerAgentId: flag(args, 'owner'),
    });
    console.log(`created ${t.id}`);
    return 0;
  }
  if (sub === 'cancel' || sub === 'pause' || sub === 'resume' || sub === 'retry') {
    const id = requirePositional(args, 0, 'task id');
    const t = await c.rpc<{ id: string; status: string }>(`task.${sub}` as never, { taskId: id });
    console.log(`${shortId(t.id)} → ${stateColored(t.status)}`);
    return 0;
  }
  if (sub === 'run') {
    const sessionId = flag(args, 'session') ?? (await c.sessionList())[0]?.id;
    if (!sessionId) throw new CliError('No session. Pass --session <id>.');
    await c.taskRun(sessionId, { only: flagList(args, 'only'), maxParallel: flag(args, 'max-parallel') ? Number(flag(args, 'max-parallel')) : undefined });
    console.log('task run accepted (watch with: forge watch)');
    return 0;
  }
  throw new CliError(`Unknown tasks subcommand '${sub}'.`);
}

async function cmdTeams(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sub = args.sub ?? 'list';
  if (sub === 'list' || sub === undefined) {
    const teams = await c.teamList(flag(args, 'session'));
    if (wantJson(args)) { printJson(teams); return 0; }
    if (teams.length === 0) {
      console.log('No teams.\n\n[Create Team: forge teams create --session <id> --name "..."]');
      return 0;
    }
    console.log(table(
      ['id', 'name', 'members', 'queued tasks', 'goal'],
      teams.map((t) => [shortId(t.id), t.name, String(t.memberIds.length), String(t.taskQueue.length), (t.sharedGoal ?? '').slice(0, 40)]),
    ));
    return 0;
  }
  if (sub === 'create') {
    const sessionId = flag(args, 'session') ?? (await c.sessionList())[0]?.id;
    if (!sessionId) throw new CliError('No session. Pass --session <id>.');
    const t = await c.teamCreate({ sessionId, name: flag(args, 'name') ?? requirePositional(args, 0, 'a --name'), sharedGoal: flag(args, 'goal') });
    console.log(`created ${t.id}`);
    return 0;
  }
  if (sub === 'inspect' || sub === 'status') {
    const id = requirePositional(args, 0, 'team id');
    if (sub === 'inspect') {
      const t = await c.teamGet(id);
      if (wantJson(args)) { printJson(t); return 0; }
      console.log(C.bold(t.name));
      console.log(`  id:      ${t.id}`);
      console.log(`  manager: ${t.managerAgentId ?? '-'}`);
      console.log(`  goal:    ${t.sharedGoal ?? '-'}`);
      console.log('  members:');
      for (const m of t.memberIds) console.log(`    ${shortId(m)}  ${t.roles[m] ?? 'member'}`);
      return 0;
    }
    const st = await c.teamStatus(id) as {
      members: { agentId: string; role: string; state: string; progress: number | null }[];
      tasks: { total: number; completed: number; running: number; blocked: number; failed: number };
      progress: number | null; blockers: { taskId?: string; reason: string }[];
    };
    if (wantJson(args)) { printJson(st); return 0; }
    console.log(C.bold('Team status'));
    console.log(`  progress: ${st.progress === null ? 'unknown' : `${st.progress}%`}`);
    console.log(`  tasks:    ${st.tasks.completed}/${st.tasks.total} done, ${st.tasks.running} running, ${st.tasks.blocked} blocked, ${st.tasks.failed} failed`);
    for (const m of st.members) console.log(`  ${shortId(m.agentId)}  ${(m.role + ' '.repeat(12)).slice(0, 12)} ${stateColored(m.state)} ${m.progress === null ? '' : `${m.progress}%`}`);
    for (const b of st.blockers) console.log(`  ${C.red('blocked')} ${b.taskId ? shortId(b.taskId) : ''} ${b.reason}`);
    return 0;
  }
  if (sub === 'add') {
    const teamId = requirePositional(args, 0, 'team id');
    const agentId = requirePositional(args, 1, 'agent id');
    await c.rpc('team.addMember', { teamId, agentId, role: flag(args, 'role') ?? 'member' });
    console.log(`added ${shortId(agentId)} to ${shortId(teamId)}`);
    return 0;
  }
  throw new CliError(`Unknown teams subcommand '${sub}'.`);
}

async function cmdMessage(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sub = args.sub ?? 'log';
  if (sub === 'send') {
    const m = await c.messageSend({
      from: flag(args, 'from') ?? 'human',
      to: flag(args, 'to') ?? requirePositional(args, 0, 'a --to recipient'),
      type: flag(args, 'type') ?? 'status',
      subject: flag(args, 'subject'),
      body: flag(args, 'body') ?? requirePositional(args, 1, 'a --body'),
      sessionId: flag(args, 'session'),
    });
    console.log(`sent ${m.id}`);
    return 0;
  }
  if (sub === 'inbox' || sub === 'log') {
    const sessionId = flag(args, 'session');
    if (sub === 'inbox') {
      const ref = requirePositional(args, 0, 'agent id/name');
      const msgs = await c.rpc<{ from: string; to: string; type: string; subject?: string; body: string; ts: string }[]>('message.inbox' as never, { agentRef: ref, sessionId });
      if (wantJson(args)) { printJson(msgs); return 0; }
      for (const m of msgs) console.log(`${C.dim(fmtTime(m.ts))} ${C.bold(m.from.slice(0, 14))} [${m.type}] ${m.subject ?? ''}\n  ${m.body.slice(0, 300)}`);
      return 0;
    }
    const conv = await c.conversation({ sessionId, teamId: flag(args, 'team'), taskId: flag(args, 'task'), limit: flag(args, 'limit') ? Number(flag(args, 'limit')) : 100 });
    if (wantJson(args)) { printJson(conv); return 0; }
    for (const m of conv) console.log(`${C.dim(fmtTime(m.ts))} ${C.bold(m.from.slice(0, 14))} → ${m.to.slice(0, 14)}: ${m.body.slice(0, 220).replace(/\n/g, ' ')}`);
    return 0;
  }
  throw new CliError(`Unknown message subcommand '${sub}'.`);
}

async function cmdModel(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sub = args.sub ?? 'status';
  if (sub === 'status' || sub === 'list') {
    const st = await c.modelStatus() as { providers: Record<string, { health: string; requests: number; tokensIn: number; tokensOut: number; latencyEwma?: number; lastError?: string }>; routing: { strategy?: string; fallback?: boolean } };
    if (wantJson(args)) { printJson(st); return 0; }
    console.log(`routing: ${st.routing.strategy ?? '?'} (fallback ${st.routing.fallback === false ? 'off' : 'on'})`);
    const rows = Object.entries(st.providers).map(([id, p]) =>
      [id, stateColored(p.health), String(p.requests), `${p.tokensIn}/${p.tokensOut}`, p.latencyEwma ? `${Math.round(p.latencyEwma)}ms` : '-', (p.lastError ?? '').slice(0, 50)]);
    console.log(rows.length > 0 ? table(['provider', 'health', 'reqs', 'tok in/out', 'latency', 'last error'], rows) : 'No providers configured.');
    return 0;
  }
  if (sub === 'refresh') {
    const health = await c.rpc('model.refresh', {});
    printJson(health);
    return 0;
  }
  if (sub === 'route') {
    const decision = await c.rpc('model.route', {
      strategy: flag(args, 'strategy'),
      preferred: parseModelRef(flag(args, 'model')),
    });
    printJson(decision);
    return 0;
  }
  throw new CliError(`Unknown model subcommand '${sub}'.`);
}

async function cmdCheckpoint(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sub = args.sub ?? 'list';
  if (sub === 'list' || sub === undefined) {
    const list = await c.checkpointList(flag(args, 'session'));
    if (wantJson(args)) { printJson(list); return 0; }
    if (list.length === 0) {
      console.log('No checkpoints.\n\n[Create Checkpoint: forge checkpoint create --session <id> --label "..."]');
      return 0;
    }
    console.log(table(
      ['id', 'label', 'created', 'git', 'event seq'],
      list.map((x) => [shortId(x.id), x.label.slice(0, 36), fmtTime(x.createdAt), x.gitHead ? x.gitHead.slice(0, 8) + (x.gitDirty ? ' (dirty)' : '') : '-', String(x.eventSeq)]),
    ));
    return 0;
  }
  if (sub === 'create') {
    const sessionId = flag(args, 'session') ?? (await c.sessionList())[0]?.id;
    if (!sessionId) throw new CliError('No session. Pass --session <id>.');
    const ckpt = await c.checkpointCreate(sessionId, flag(args, 'label') ?? requirePositional(args, 0, 'a --label'));
    console.log(`created ${ckpt.id}`);
    return 0;
  }
  if (sub === 'restore') {
    const id = requirePositional(args, 0, 'checkpoint id');
    const ckpt = await c.checkpointRestore(id, { restoreGit: flagBool(args, 'git'), allowDirtyRestore: flagBool(args, 'allow-dirty') });
    console.log(`restored ${shortId(ckpt.id)} (${ckpt.label})`);
    return 0;
  }
  if (sub === 'rollback') {
    const sessionId = flag(args, 'session') ?? (await c.sessionList())[0]?.id;
    if (!sessionId) throw new CliError('No session. Pass --session <id>.');
    const ckpt = await c.rpc<{ id: string; label: string }>('checkpoint.rollback' as never, { sessionId, restoreGit: flagBool(args, 'git'), allowDirtyRestore: flagBool(args, 'allow-dirty') });
    console.log(`rolled back to ${shortId(ckpt.id)} (${ckpt.label})`);
    return 0;
  }
  throw new CliError(`Unknown checkpoint subcommand '${sub}'.`);
}

async function cmdApprovals(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sub = args.sub ?? 'list';
  if (sub === 'list' || sub === undefined) {
    const list = await c.approvalList();
    if (wantJson(args)) { printJson(list); return 0; }
    if (list.length === 0) {
      console.log('No pending approvals.');
      return 0;
    }
    console.log(table(
      ['id', 'kind', 'risk', 'summary', 'requested'],
      list.map((a) => [shortId(a.id), a.kind, stateColored(a.risk), a.summary.slice(0, 60), fmtTime(a.requestedAt)]),
    ));
    return 0;
  }
  if (sub === 'resolve' || sub === 'approve' || sub === 'deny') {
    const id = requirePositional(args, 0, 'approval id');
    const approved = sub === 'approve' ? true : sub === 'deny' ? false : flagBool(args, 'approve') ? true : flagBool(args, 'deny') ? false : undefined;
    if (approved === undefined) throw new CliError('Pass --approve or --deny.');
    const r = await c.approvalResolve(id, approved);
    console.log(`${shortId(r.id)} → ${stateColored(r.status)}`);
    return 0;
  }
  throw new CliError(`Unknown approvals subcommand '${sub}'.`);
}

async function cmdMemory(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sub = args.sub ?? 'list';
  if (sub === 'put') {
    const e = await c.rpc('memory.put', {
      scope: flag(args, 'scope') ?? 'project',
      scopeId: flag(args, 'scope-id') ?? projectDir(args),
      key: flag(args, 'key') ?? requirePositional(args, 0, 'a --key'),
      value: flag(args, 'value') ?? requirePositional(args, 1, 'a --value'),
      tags: flagList(args, 'tags') ?? [],
    });
    printJson(e);
    return 0;
  }
  if (sub === 'get') {
    const e = await c.rpc('memory.get', {
      scope: flag(args, 'scope') ?? 'project',
      scopeId: flag(args, 'scope-id') ?? projectDir(args),
      key: flag(args, 'key') ?? requirePositional(args, 0, 'a --key'),
    });
    printJson(e);
    return 0;
  }
  if (sub === 'list') {
    const list = await c.rpc('memory.list', {
      scope: flag(args, 'scope') ?? 'project',
      scopeId: flag(args, 'scope-id') ?? flag(args, 'session') ?? projectDir(args),
    });
    printJson(list);
    return 0;
  }
  if (sub === 'search') {
    const hits = await c.rpc('memory.search', { query: flag(args, 'query') ?? requirePositional(args, 0, 'a query') });
    printJson(hits);
    return 0;
  }
  if (sub === 'delete') {
    await c.rpc('memory.delete', { id: requirePositional(args, 0, 'memory id') });
    console.log('deleted');
    return 0;
  }
  throw new CliError(`Unknown memory subcommand '${sub}'.`);
}

async function cmdSession(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sub = args.sub ?? 'list';
  if (sub === 'list' || sub === undefined) {
    const sessions = await c.sessionList();
    if (wantJson(args)) { printJson(sessions); return 0; }
    if (sessions.length === 0) {
      console.log('No sessions.');
      return 0;
    }
    console.log(table(
      ['id', 'name', 'status', 'agents', 'tasks', 'updated'],
      sessions.map((s) => [shortId(s.id), s.name.slice(0, 30), stateColored(s.status), String(s.agentIds.length), String(s.taskIds.length), fmtTime(s.updatedAt)]),
    ));
    return 0;
  }
  if (sub === 'inspect' || sub === 'resume' || sub === 'close') {
    const id = requirePositional(args, 0, 'session id');
    const s = sub === 'inspect' ? await c.sessionGet(id) : sub === 'resume' ? await c.sessionResume(id) : await c.sessionClose(id);
    if (wantJson(args)) { printJson(s); return 0; }
    console.log(`${shortId(s.id)} ${s.name} [${stateColored(s.status)}] agents=${s.agentIds.length} tasks=${s.taskIds.length} teams=${s.teamIds.length}`);
    return 0;
  }
  throw new CliError(`Unknown session subcommand '${sub}'.`);
}

async function cmdTool(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sub = args.sub ?? 'list';
  if (sub === 'list' || sub === undefined) {
    const tools = await c.toolList();
    if (wantJson(args)) { printJson(tools); return 0; }
    console.log(table(['tool', 'description'], tools.map((t) => [t.name, t.description.slice(0, 80)])));
    return 0;
  }
  if (sub === 'invoke') {
    const name = requirePositional(args, 0, 'tool name');
    const inputRaw = flag(args, 'input') ?? '{}';
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(inputRaw) as Record<string, unknown>;
    } catch {
      throw new CliError('--input must be valid JSON');
    }
    const out = await c.toolInvoke(name, input, { sessionId: flag(args, 'session') });
    printJson(out);
    return out.ok ? 0 : 1;
  }
  throw new CliError(`Unknown tool subcommand '${sub}'.`);
}

async function cmdWatch(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const types = flagList(args, 'types');
  const sessionId = flag(args, 'session');
  console.log(C.dim(`watching ${serverUrl(args)}${sessionId ? ` session=${sessionId}` : ''} (Ctrl+C to stop)`));
  const verbose = flagBool(args, 'verbose');
  const unsub = c.subscribeEvents({
    filter: { sessionId, types },
    onEvent: (e: ForgeEventDTO) => {
      const d = e.data as Record<string, unknown>;
      const sim = e.simulated ? C.yellow('[sim] ') : '';
      const summary = e.type === 'agent.message.sent'
        ? `${String(d.from ?? '').slice(0, 12)} → ${String(d.to ?? '').slice(0, 12)}: ${String(d.body ?? '').slice(0, 140)}`
        : e.type === 'tool.completed' || e.type === 'tool.failed'
          ? `${String(d.tool)} (${String(d.durationMs)}ms)`
          : e.type.startsWith('file.')
            ? String(d.path ?? '')
            : e.type === 'agent.progress'
              ? `${typeof d.progress === 'number' ? `${d.progress}% ` : ''}${String(d.currentAction ?? d.note ?? '')}`
              : JSON.stringify(d).slice(0, 200);
      if (!verbose && (e.type === 'tool.output' || e.type === 'model.started')) return;
      console.log(`${C.dim(fmtTime(e.ts))} ${sim}${e.type} ${C.dim(summary)}`);
    },
    onStatus: (s, detail) => {
      if (s !== 'connected') console.error(C.dim(`stream ${s}${detail ? `: ${detail}` : ''}`));
    },
  });
  await new Promise<void>((resolvePromise) => {
    process.on('SIGINT', () => { unsub(); resolvePromise(); });
    process.on('SIGTERM', () => { unsub(); resolvePromise(); });
  });
  return 0;
}

async function cmdLogs(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const events = await c.eventsReplay({
    sessionId: flag(args, 'session'),
    types: flagList(args, 'types'),
    sinceSeq: flag(args, 'since') ? Number(flag(args, 'since')) : undefined,
    limit: flag(args, 'limit') ? Number(flag(args, 'limit')) : 100,
  });
  if (wantJson(args)) { printJson(events); return 0; }
  for (const e of events) {
    console.log(`${C.dim(fmtTime(e.ts))} ${C.dim(`#${e.seq}`)} ${e.simulated ? C.yellow('[sim] ') : ''}${e.type} ${C.dim(JSON.stringify(e.data).slice(0, 180))}`);
  }
  return 0;
}

async function cmdReview(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  const sessionId = flag(args, 'session') ?? (await c.sessionList())[0]?.id;
  if (!sessionId) throw new CliError('No session. Pass --session <id>.');
  const verdict = await c.rpc<{ verdict: string; findings: string[] }>('runtime.review', {
    sessionId, agentId: flag(args, 'agent'), taskId: flag(args, 'task'),
  });
  if (wantJson(args)) { printJson(verdict); return 0; }
  console.log(`verdict: ${stateColored(verdict.verdict)}`);
  for (const f of verdict.findings) console.log(`  - ${f}`);
  return verdict.verdict === 'approved' ? 0 : 1;
}

async function cmdConfig(args: ParsedArgs): Promise<number> {
  const c = makeClient(args);
  printJson(await c.configGet());
  return 0;
}

// Wrap ForgeConfig import usage (tree-shake guard for type-only import).
void (null as unknown as ForgeConfig | null);
void globalConfigDir;

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`forge: ${(e as Error).message}`);
    process.exit(1);
  },
);
