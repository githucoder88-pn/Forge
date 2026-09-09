/**
 * ForgeRuntime — the single authoritative runtime. Owns the store, event
 * bus, sessions, agents, tasks, teams, models, tools and checkpoints, and
 * exposes the high-level flows: enhance → plan → execute → review.
 * CLI / server / desktop clients are thin consumers of this runtime.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AgentId, SessionId, TaskId, TeamId, nowIso } from './ids.js';
import { ForgeError } from './errors.js';
import { EventBus } from './events.js';
import { ForgeConfig, globalConfigDir, loadConfig, resolveApiKey } from './config.js';
import { SqliteStore } from './store.js';
import { ApprovalGate } from './permissions.js';
import { Workspace } from './workspace.js';
import { ToolRegistry, createToolRegistry } from './tools.js';
import { ModelProvider, createProvider, EchoProvider } from './providers.js';
import { ModelRouter, RouteRequest } from './router.js';
import { ContextEngine } from './context.js';
import { MemoryStore } from './memory.js';
import { SessionManager, Session } from './sessions.js';
import { TaskScheduler, Task, TaskExecutor } from './tasks.js';
import { TeamManager } from './teams.js';
import { MessageBus } from './messaging.js';
import { AgentRuntime, Agent, AgentResult, StartOptions } from './agents.js';
import { CheckpointManager, Checkpoint } from './checkpoints.js';
import { loadPlugins } from './plugins.js';

export interface ForgeRuntimeOptions {
  projectDir: string;
  config?: ForgeConfig;
  /** Defaults to <globalDir>/forge.db. Use ':memory:' for ephemeral/test use. */
  storePath?: string;
  /** Extra providers (e.g. scripted test doubles) registered first. */
  providers?: ModelProvider[];
  /** Directory of local plugins to load (fully trusted — see SECURITY.md). */
  pluginsDir?: string;
  /** Allow the simulated echo fallback when no real provider exists. */
  allowSimulatedFallback?: boolean;
  bus?: EventBus;
  sessionName?: string;
}

export interface RunGoalOptions {
  agentName?: string;
  role?: string;
  capabilities?: string[];
  model?: { provider: string; model: string };
  maxIterations?: number;
  budgetTokens?: number;
  enhance?: boolean;
  plan?: boolean;
  team?: { name: string; roles: string[] };
  taskId?: TaskId;
  sessionId?: SessionId;
}

export interface RunReport {
  sessionId: SessionId;
  agentId?: AgentId;
  teamId?: TeamId;
  taskIds: TaskId[];
  state: string;
  agents: AgentResult[];
  filesChanged: string[];
  inputTokens: number;
  outputTokens: number;
  summary: string;
  simulated: boolean;
}

export interface Enhancement {
  requirements: string[];
  inferences: string[];
  goals: string[];
  constraints: string[];
  affectedSurfaces: string[];
  acceptanceCriteria: string[];
  risks: string[];
}

export interface ReviewVerdict {
  verdict: 'approved' | 'needs_changes' | 'blocked';
  findings: string[];
  reviewer: string;
}

export class ForgeRuntime {
  readonly config: ForgeConfig;
  readonly projectDir: string;
  readonly store: SqliteStore;
  readonly bus: EventBus;
  readonly gate: ApprovalGate;
  readonly tools: ToolRegistry;
  readonly router: ModelRouter;
  readonly sessions: SessionManager;
  readonly scheduler: TaskScheduler;
  readonly teams: TeamManager;
  readonly messages: MessageBus;
  readonly memory: MemoryStore;
  readonly agents: AgentRuntime;
  readonly checkpoints: CheckpointManager;
  readonly allowSimulatedFallback: boolean;
  private closed = false;

  private constructor(opts: ForgeRuntimeOptions, config: ForgeConfig, store: SqliteStore, bus: EventBus) {
    this.config = config;
    this.projectDir = resolve(opts.projectDir);
    this.store = store;
    this.bus = bus;
    this.allowSimulatedFallback = opts.allowSimulatedFallback ?? false;
    mkdirSync(this.projectDir, { recursive: true });

    this.gate = new ApprovalGate({
      timeoutMs: config.permissions?.approvalTimeoutMs ?? 120_000,
      onRequest: (r) => bus.emit({ type: 'approval.requested', data: { ...r } }),
    });
    this.tools = createToolRegistry();
    this.router = new ModelRouter({
      defaultStrategy: config.routing?.strategy,
      fallbackEnabled: config.routing?.fallback,
      defaultTimeoutMs: config.orchestration?.defaultTimeoutMs,
      defaultModels: defaultModelsFromConfig(config),
      bus,
    });
    for (const p of opts.providers ?? []) this.router.registerProvider(p);
    const configured = Object.entries(config.providers ?? {});
    for (const [id, cfg] of configured) {
      try {
        const provider = createProvider(id, cfg);
        if (provider) this.router.registerProvider(provider);
        else bus.emit({ type: 'runtime.warning', data: { message: `Provider '${id}' not configured (missing credentials?) — skipped`, provider: id } });
      } catch (e) {
        bus.emit({ type: 'runtime.warning', data: { message: `Provider '${id}' misconfigured: ${(e as Error).message}`, provider: id } });
      }
    }
    if (this.router.providerIds().length === 0) {
      if (this.allowSimulatedFallback) {
        this.router.registerProvider(new EchoProvider());
        bus.emit({ type: 'runtime.warning', data: { message: 'No model providers configured — using SIMULATED echo fallback (explicitly allowed). Responses are not real model output.' } });
      } else {
        bus.emit({ type: 'runtime.warning', data: { message: 'No model providers configured. Set an API key (e.g. OPENAI_API_KEY) or start Ollama/LM Studio.' } });
      }
    }

    this.sessions = new SessionManager(store, bus);
    this.scheduler = new TaskScheduler(store, bus);
    this.teams = new TeamManager(store, bus);
    this.messages = new MessageBus(store, bus);
    this.memory = new MemoryStore(store);
    this.agents = new AgentRuntime({
      store, bus, tools: this.tools, router: this.router, gate: this.gate,
      scheduler: this.scheduler, messages: this.messages, memory: this.memory,
      contextEngineFactory: (ws) => new ContextEngine({ workspace: ws, memory: this.memory }),
      projectDir: this.projectDir,
      defaultAutonomy: config.autonomy?.default ?? 'workspace-write',
      defaultPolicy: config.autonomy?.approvalPolicy ?? 'on-risky-commands',
      defaultModel: config.models?.primary,
      defaultStrategy: config.routing?.strategy,
      maxIterations: config.orchestration?.maxIterations,
      defaultTimeoutMs: config.orchestration?.defaultTimeoutMs,
      verboseEvents: config.performance?.verboseEvents,
    });
    this.checkpoints = new CheckpointManager(store, bus, this.projectDir);
  }

  static async create(opts: ForgeRuntimeOptions): Promise<ForgeRuntime> {
    const { config: fileConfig } = loadConfig(opts.projectDir);
    const config = opts.config ?? fileConfig;
    const storePath = opts.storePath ?? config.session?.storePath ?? `${globalConfigDir()}/forge.db`;
    if (storePath !== ':memory:') mkdirSync(dirname(storePath), { recursive: true });
    const store = new SqliteStore({ path: storePath });
    const bus = opts.bus ?? new EventBus({ persist: (e) => { try { store.saveEvent(e); } catch { /* ignore */ } } });
    bus.setMinimumSeq(store.maxEventSeq());
    const rt = new ForgeRuntime(opts, config, store, bus);
    // Measure real provider health at boot so `model status` never guesses.
    try {
      await rt.refreshProviderHealth();
    } catch {
      // Health refresh is best-effort; individual failures are recorded per-provider.
    }
    if (opts.pluginsDir) {
      await loadPlugins(opts.pluginsDir, { tools: rt.tools, router: rt.router, bus, projectDir: rt.projectDir });
    }
    return rt;
  }

  workspaceFor(sessionId?: SessionId, agentId?: AgentId, taskId?: TaskId): Workspace {
    return new Workspace({ root: this.projectDir, sessionId, agentId, taskId, bus: this.bus, store: this.store });
  }

  ensureSession(name?: string, sessionId?: SessionId): Session {
    if (sessionId) return this.sessions.resume(sessionId);
    const existing = this.sessions.list().filter((s) => s.projectDir === this.projectDir && s.status === 'active' && !s.simulated);
    if (existing.length > 0 && !name) return existing[0] as Session;
    const sess = this.sessions.create({ name, projectDir: this.projectDir });
    return sess;
  }

  // ------------------------------------------------------------ run flows ---

  /** Solo flow: optionally enhance → plan → one agent executes → report. */
  async runGoal(goal: string, opts?: RunGoalOptions): Promise<RunReport> {
    const session = opts?.sessionId ? this.sessions.resume(opts.sessionId) : this.ensureSession();
    let effectiveGoal = goal;
    if (opts?.enhance) {
      const enhancement = await this.enhanceGoal(session.id, goal);
      effectiveGoal = [
        `Objective: ${goal}`,
        enhancement.goals.length > 0 ? `Goals:\n${enhancement.goals.map((g) => `- ${g}`).join('\n')}` : '',
        enhancement.requirements.length > 0 ? `Requirements:\n${enhancement.requirements.map((g) => `- ${g}`).join('\n')}` : '',
        enhancement.constraints.length > 0 ? `Constraints:\n${enhancement.constraints.map((g) => `- ${g}`).join('\n')}` : '',
        enhancement.acceptanceCriteria.length > 0 ? `Acceptance criteria:\n${enhancement.acceptanceCriteria.map((g) => `- ${g}`).join('\n')}` : '',
        enhancement.inferences.length > 0 ? `Assumptions (validate; do not treat as requirements):\n${enhancement.inferences.map((g) => `- ${g}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
    }

    let taskIds: TaskId[] = [];
    if (opts?.plan) {
      const tasks = await this.planGoal(session.id, effectiveGoal);
      taskIds = tasks.map((t) => t.id);
    }

    if (opts?.team) {
      return this.runTeamGoal(session.id, effectiveGoal, taskIds, opts);
    }

    const agent = this.agents.createAgent({
      sessionId: session.id,
      name: opts?.agentName ?? 'forge',
      role: opts?.role ?? 'engineer',
      capabilities: opts?.capabilities,
      model: opts?.model,
    });
    this.sessions.attach(session.id, { agentId: agent.id });
    const firstTask = taskIds[0];
    if (firstTask && !opts?.taskId) this.scheduler.setOwner(firstTask, agent.id);
    const startOpts: StartOptions = { taskId: opts?.taskId ?? firstTask, maxIterations: opts?.maxIterations, budgetTokens: opts?.budgetTokens, model: opts?.model };
    const result = await this.agents.start(agent.id, effectiveGoal, startOpts);
    if ((opts?.taskId ?? firstTask) && result.state === 'completed') {
      try {
        const t = this.scheduler.get((opts?.taskId ?? firstTask) as TaskId);
        if (t.status === 'ready' || t.status === 'pending' || t.status === 'running') {
          // Mark through a direct transition path: run a no-op executor completion.
          t.status = 'completed';
          t.progress = 100;
          t.completedAt = nowIso();
          t.updatedAt = nowIso();
          this.store.putDoc('task', t.id, t.sessionId, t.updatedAt, t);
          this.bus.emit({ type: 'task.completed', sessionId: session.id, taskId: t.id, agentId: agent.id, data: { by: 'agent', agentId: agent.id } });
        }
      } catch { /* task vanished — ignore */ }
    }
    return this.buildReport(session.id, [result], taskIds, undefined, agent.id);
  }

  /** Multi-agent flow: team of agents executes the task graph in parallel. */
  private async runTeamGoal(sessionId: SessionId, goal: string, taskIds: TaskId[], opts: RunGoalOptions): Promise<RunReport> {
    const roles = opts.team?.roles?.length ? opts.team.roles : ['backend', 'frontend', 'qa'];
    const team = this.teams.create({ sessionId, name: opts.team?.name ?? 'engineering', sharedGoal: goal });
    const members: Agent[] = [];
    for (const role of roles) {
      const member = this.agents.createAgent({ sessionId, name: `${role}`, role, model: opts?.model });
      this.teams.addMember(team.id, member.id, role);
      this.sessions.attach(sessionId, { agentId: member.id });
      members.push(member);
    }
    this.sessions.attach(sessionId, { teamId: team.id });

    let tasks: Task[] = taskIds.map((id) => this.scheduler.get(id));
    if (tasks.length === 0) {
      const t = this.scheduler.create({ sessionId, title: goal.slice(0, 120), description: goal, teamId: team.id });
      tasks = [t];
      taskIds = [t.id];
    }
    for (const t of tasks) this.teams.enqueueTask(team.id, t.id);
    // Round-robin assignment for unowned tasks.
    let i = 0;
    for (const t of tasks) {
      if (!t.ownerAgentId) {
        const owner = members[i++ % members.length] as Agent;
        this.scheduler.setOwner(t.id, owner.id);
        t.ownerAgentId = owner.id;
      }
    }

    const results: AgentResult[] = [];
    const executor: TaskExecutor = async (task, ctx) => {
      const owner = members.find((m) => m.id === task.ownerAgentId) ?? members[0];
      if (!owner) throw new ForgeError('INVALID_STATE', 'Team has no members');
      this.agents.setTask(owner.id, task.id);
      ctx.reportProgress(5, `assigned to ${owner.name}`);
      const res = await this.agents.start(owner.id, `Team goal: ${goal}\n\nYour task (${task.id}): ${task.title}\n${task.description}\n\nCoordinate via messages when you need teammates.`, {
        taskId: task.id, maxIterations: opts.maxIterations, model: opts.model,
      });
      results.push(res);
      if (ctx.signal.aborted) throw new ForgeError('CANCELLED', 'cancelled');
      if (res.state !== 'completed') throw new ForgeError('TOOL_FAILED', `Agent ${owner.name} ended in state ${res.state}: ${res.lastError ?? 'unknown'}`);
      return { artifacts: [] };
    };
    await this.scheduler.runAll(sessionId, executor, { maxParallel: Math.min(members.length, this.config.orchestration?.maxParallelTasks ?? 4) });
    return this.buildReport(sessionId, results, taskIds, team.id, undefined);
  }

  private buildReport(sessionId: SessionId, results: AgentResult[], taskIds: TaskId[], teamId?: TeamId, agentId?: AgentId): RunReport {
    const files = new Set<string>();
    for (const r of results) {
      void r;
    }
    // Attribute files changed during this session from the file-event log.
    const recent = this.store.loadEvents({ sessionId, types: ['file.created', 'file.modified'], limit: 500 });
    for (const e of recent) {
      const p = (e.data as { path?: string })?.path;
      if (p) files.add(p);
    }
    const failed = results.filter((r) => r.state === 'failed' || r.state === 'cancelled');
    const simulated = results.length > 0 && results.every((r) => {
      try { return this.agents.get(r.agentId).simulated === true; } catch { return false; }
    });
    const summary = results.map((r) => `### ${r.agentId} [${r.state}]\n${r.summary}`).join('\n\n') || 'No agent output.';
    return {
      sessionId, agentId, teamId, taskIds,
      state: failed.length > 0 ? 'failed' : 'completed',
      agents: results,
      filesChanged: [...files],
      inputTokens: results.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: results.reduce((n, r) => n + r.outputTokens, 0),
      summary,
      simulated,
    };
  }

  // ------------------------------------------------------- enhance/plan ---

  async enhanceGoal(sessionId: SessionId, goal: string): Promise<Enhancement> {
    const fallback: Enhancement = { requirements: [goal], inferences: [], goals: [goal], constraints: [], affectedSurfaces: [], acceptanceCriteria: [], risks: [] };
    try {
      const res = await this.router.chat(
        { sessionId, requiredCapabilities: ['text'] },
        {
          messages: [
            { role: 'system', content: 'You clarify vague engineering requests. Reply with JSON ONLY: {"goals":[],"requirements":[],"inferences":[],"constraints":[],"affectedSurfaces":[],"acceptanceCriteria":[],"risks":[]}. requirements = explicitly stated by the user. inferences = your guesses (mark uncertain ones). Never invent product requirements beyond what is asked.' },
            { role: 'user', content: goal },
          ],
          temperature: 0.1,
        },
      );
      const parsed = extractJson(res.content) as Partial<Enhancement> | undefined;
      if (!parsed) return fallback;
      return {
        requirements: asStrings(parsed.requirements, fallback.requirements),
        inferences: asStrings(parsed.inferences, []),
        goals: asStrings(parsed.goals, [goal]),
        constraints: asStrings(parsed.constraints, []),
        affectedSurfaces: asStrings(parsed.affectedSurfaces, []),
        acceptanceCriteria: asStrings(parsed.acceptanceCriteria, []),
        risks: asStrings(parsed.risks, []),
      };
    } catch (e) {
      this.bus.emit({ type: 'runtime.warning', sessionId, data: { message: `Enhancer unavailable (${(e as Error).message}) — proceeding with the raw goal.` } });
      return fallback;
    }
  }

  async planGoal(sessionId: SessionId, goal: string, opts?: { maxTasks?: number }): Promise<Task[]> {
    const makeSingle = (reason: string): Task[] => {
      const t = this.scheduler.create({ sessionId, title: goal.slice(0, 120), description: `${goal}\n\n(planner note: ${reason})` });
      this.bus.emit({ type: 'plan.created', sessionId, data: { tasks: [t.id], single: true, reason } });
      return [t];
    };
    let res;
    try {
      res = await this.router.chat(
        { sessionId, requiredCapabilities: ['text'] },
        {
          messages: [
            { role: 'system', content: `You are a planner producing an executable task graph. Reply with JSON ONLY: {"goal":"...","tasks":[{"id":"T1","title":"...","description":"...","depends_on":[]}]}. Rules: ids T1..Tn; depends_on references earlier ids only; max ${opts?.maxTasks ?? 8} tasks; each task independently verifiable; first task inspects relevant code.` },
            { role: 'user', content: goal },
          ],
          temperature: 0.1,
        },
      );
    } catch (e) {
      return makeSingle(`planner model unavailable: ${(e as Error).message}`);
    }
    const parsed = extractJson(res.content) as { tasks?: { id?: string; title?: string; description?: string; depends_on?: string[] }[] } | undefined;
    if (!parsed?.tasks?.length) return makeSingle('planner returned no tasks');
    const tempToReal = new Map<string, TaskId>();
    const created: Task[] = [];
    try {
      for (const t of parsed.tasks.slice(0, opts?.maxTasks ?? 8)) {
        if (!t.title?.trim()) continue;
        const deps = (t.depends_on ?? []).map((d) => tempToReal.get(d)).filter((d): d is TaskId => !!d);
        const real = this.scheduler.create({ sessionId, title: t.title.slice(0, 200), description: t.description ?? '', dependsOn: deps });
        if (t.id) tempToReal.set(t.id, real.id);
        created.push(real);
      }
    } catch (e) {
      return makeSingle(`planner output invalid: ${(e as Error).message}`);
    }
    if (created.length === 0) return makeSingle('planner produced no valid tasks');
    this.bus.emit({ type: 'plan.created', sessionId, data: { tasks: created.map((t) => t.id), goal: goal.slice(0, 500) } });
    return created;
  }

  // ---------------------------------------------------------------- review ---

  async reviewChanges(sessionId: SessionId, opts?: { agentId?: AgentId; taskId?: TaskId; reviewerModel?: { provider: string; model: string } }): Promise<ReviewVerdict> {
    const ws = this.workspaceFor(sessionId, opts?.agentId, opts?.taskId);
    const { runProcess } = await import('./tools.js');
    const diff = await runProcess('git', ['diff', 'HEAD', '--', '.'], { cwd: this.projectDir, timeoutMs: 30_000 }).catch(() => ({ stdout: '' }) as { stdout: string });
    const status = await runProcess('git', ['status', '--porcelain'], { cwd: this.projectDir, timeoutMs: 30_000 }).catch(() => ({ stdout: '' }) as { stdout: string });
    void ws;
    if (!diff.stdout.trim() && !status.stdout.trim()) {
      return { verdict: 'blocked', findings: ['No changes detected — nothing to review.'], reviewer: 'forge-reviewer' };
    }
    const res = await this.router.chat(
      { sessionId, agentId: opts?.agentId, taskId: opts?.taskId, preferred: opts?.reviewerModel ?? this.config.models?.reviewer, requiredCapabilities: ['text'] },
      {
        messages: [
          { role: 'system', content: 'You are a senior code reviewer. Reply with JSON ONLY: {"verdict":"approved|needs_changes|blocked","findings":["..."]}. Judge requirements fit, correctness, tests, security and style. Be specific; cite files.' },
          { role: 'user', content: `Changed files:\n${status.stdout.slice(0, 4000)}\n\nDiff:\n${diff.stdout.slice(0, 30000)}` },
        ],
        temperature: 0.1,
      },
    );
    const parsed = extractJson(res.content) as { verdict?: string; findings?: string[] } | undefined;
    const verdict: ReviewVerdict = {
      verdict: parsed?.verdict === 'approved' || parsed?.verdict === 'needs_changes' || parsed?.verdict === 'blocked' ? parsed.verdict : 'needs_changes',
      findings: asStrings(parsed?.findings, ['Reviewer returned no structured findings.']),
      reviewer: 'forge-reviewer',
    };
    this.bus.emit({ type: 'review.decision', sessionId, agentId: opts?.agentId, taskId: opts?.taskId, data: { ...verdict } });
    if (opts?.agentId) {
      this.messages.send({
        sessionId, taskId: opts.taskId, from: 'reviewer', to: opts.agentId,
        type: verdict.verdict === 'approved' ? 'response' : 'request',
        subject: `Review: ${verdict.verdict}`,
        body: verdict.findings.map((f) => `- ${f}`).join('\n'),
      });
    }
    return verdict;
  }

  // ------------------------------------------------------- checkpoints ---

  async createCheckpoint(sessionId: SessionId, label: string): Promise<Checkpoint> {
    return this.checkpoints.create(sessionId, label, {
      agents: this.agents.list(sessionId),
      tasks: this.scheduler.list(sessionId),
      teams: this.teams.list(sessionId),
    }, this.bus.latestSeq());
  }

  /**
   * Restore orchestration state from a checkpoint. Always takes a safety
   * checkpoint first. Git restore is opt-in and stashes current work.
   */
  async restoreCheckpoint(id: string, opts?: { restoreGit?: boolean; allowDirtyRestore?: boolean }): Promise<Checkpoint> {
    const ckpt = this.checkpoints.get(id);
    await this.createCheckpoint(ckpt.sessionId, `pre-restore-${nowIso()}`);
    // Park running agents of this session so they cannot resurrect deleted docs.
    for (const runningId of this.agents.runningIds()) {
      try {
        if (this.agents.get(runningId).sessionId === ckpt.sessionId) this.agents.cancel(runningId);
      } catch { /* agent vanished */ }
    }
    for (let i = 0; i < 40; i++) {
      const still = this.agents.runningIds().filter((rid) => {
        try { return this.agents.get(rid).sessionId === ckpt.sessionId; } catch { return false; }
      });
      if (still.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Delete session docs created after the snapshot, then rewrite snapshot docs.
    const snapAgents = new Set((ckpt.state.agents as Agent[]).map((a) => a.id));
    const snapTasks = new Set((ckpt.state.tasks as Task[]).map((t) => t.id));
    const snapTeams = new Set((ckpt.state.teams as { id: string }[]).map((t) => t.id));
    for (const a of this.agents.list(ckpt.sessionId)) {
      if (!snapAgents.has(a.id)) this.store.deleteDoc('agent', a.id);
    }
    for (const t of this.scheduler.list(ckpt.sessionId)) {
      if (!snapTasks.has(t.id)) this.store.deleteDoc('task', t.id);
    }
    for (const t of this.teams.list(ckpt.sessionId)) {
      if (!snapTeams.has(t.id)) this.store.deleteDoc('team', t.id);
    }
    for (const a of ckpt.state.agents as Agent[]) {
      // Running states cannot be restored — park them as idle for explicit resume.
      if (['executing', 'planning', 'waiting_for_tool', 'waiting_for_agent', 'reviewing'].includes(a.state)) {
        a.state = 'idle';
        a.lastError = `interrupted by restore of checkpoint ${ckpt.id}; resume explicitly`;
      }
      this.store.putDoc('agent', a.id, a.sessionId, nowIso(), a);
    }
    for (const t of ckpt.state.teams as { id: string; sessionId: SessionId }[]) {
      this.store.putDoc('team', t.id, t.sessionId, nowIso(), t);
    }
    for (const t of ckpt.state.tasks as Task[]) {
      if (t.status === 'running') {
        t.status = 'pending';
        t.errors.push({ message: `interrupted by restore of checkpoint ${ckpt.id}`, at: nowIso() });
      }
      this.store.putDoc('task', t.id, t.sessionId, nowIso(), t);
    }
    if (opts?.restoreGit) await this.checkpoints.restoreGit(id, { allowDirtyRestore: opts.allowDirtyRestore });
    this.bus.emit({ type: 'checkpoint.restored', sessionId: ckpt.sessionId, data: { checkpointId: ckpt.id, label: ckpt.label, git: opts?.restoreGit ?? false } });
    return ckpt;
  }

  async rollback(sessionId: SessionId, opts?: { restoreGit?: boolean; allowDirtyRestore?: boolean }): Promise<Checkpoint> {
    const list = this.checkpoints.list(sessionId).filter((c) => !c.label.startsWith('pre-restore-'));
    if (list.length === 0) throw new ForgeError('NOT_FOUND', 'No checkpoints to roll back to');
    const target = list[list.length - 1] as Checkpoint;
    return this.restoreCheckpoint(target.id, opts);
  }

  // -------------------------------------------------------------- router ---

  routePreview(req: RouteRequest): Promise<import('./router.js').RouteDecision> {
    return this.router.route(req);
  }

  providerStatus(): { providers: Record<string, unknown>; routing: { strategy?: string; fallback?: boolean } } {
    return {
      providers: this.router.stats(),
      routing: { strategy: this.config.routing?.strategy, fallback: this.config.routing?.fallback },
    };
  }

  async refreshProviderHealth(): Promise<Record<string, string>> {
    return this.router.refreshHealth();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Park running agents so resume is explicit and safe.
    for (const a of this.agents.list()) {
      if (['executing', 'planning', 'waiting_for_tool', 'waiting_for_agent', 'reviewing'].includes(a.state)) {
        this.agents.cancel(a.id);
      }
    }
    this.bus.close();
    this.store.close();
  }
}

function defaultModelsFromConfig(config: ForgeConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (config.models?.primary) out[config.models.primary.provider] = config.models.primary.model;
  if (config.models?.fast) out[config.models.fast.provider] = config.models.fast.model;
  if (config.models?.reviewer) out[config.models.reviewer.provider] = config.models.reviewer.model;
  if (config.models?.fallbackChain) {
    for (const f of config.models.fallbackChain) out[f.provider] ??= f.model;
  }
  void resolveApiKey;
  return out;
}

export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function asStrings(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.map((x) => String(x)).filter((s) => s.trim().length > 0);
  return out.length > 0 ? out : fallback;
}
