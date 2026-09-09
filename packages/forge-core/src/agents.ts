/**
 * Agent runtime: real agent objects with a genuine model→tool→observe loop.
 * Every visible agent maps to one of these; progress, state, tokens and
 * file changes are measured, never fabricated.
 */
import { AgentId, SessionId, TaskId, TeamId, agentId, nowIso } from './ids.js';
import { ForgeError, asForgeError } from './errors.js';
import { EventBus } from './events.js';
import type { ModelRef } from './config.js';
import type { SqliteStore } from './store.js';
import { Workspace } from './workspace.js';
import { ToolRegistry, toJsonSchema } from './tools.js';
import type { ToolContextBase } from './tools.js';
import type { ApprovalGate } from './permissions.js';
import type { ApprovalPolicy, AutonomyLevel } from './permissions.js';
import type { ModelRouter as ModelRouterType, RoutingStrategy } from './router.js';
import type { ChatMessage, ChatResponse, ToolSpec } from './providers.js';
import { ContextEngine, formatStats } from './context.js';
import type { MemoryStore } from './memory.js';
import type { TaskScheduler } from './tasks.js';
import type { MessageBus } from './messaging.js';
import type { AgentMessageType } from './messaging.js';
import { estimateTokens } from './providers.js';

export type AgentState =
  | 'created' | 'idle' | 'planning' | 'executing' | 'waiting_for_tool'
  | 'waiting_for_agent' | 'blocked' | 'reviewing' | 'paused'
  | 'failed' | 'completed' | 'cancelled';

export interface PlanStep {
  title: string;
  done: boolean;
}

export interface AgentMetrics {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  filesChanged: number;
  iterations: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface Agent {
  id: AgentId;
  sessionId: SessionId;
  name: string;
  role: string;
  capabilities: string[];
  model?: ModelRef;
  autonomy: AutonomyLevel;
  policy: ApprovalPolicy;
  state: AgentState;
  progress: number | null;
  currentTaskId?: TaskId;
  currentAction?: string;
  parentAgentId?: AgentId;
  teamId?: TeamId;
  workspacePath?: string;
  children: AgentId[];
  goal?: string;
  plan: PlanStep[];
  metrics: AgentMetrics;
  transcript: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  simulated?: boolean;
  /** Consume cursor for waitForMessage (queue semantics: each message matched once). */
  lastReadTs?: string;
  lastReadId?: string;
}

export interface AgentResult {
  agentId: AgentId;
  state: AgentState;
  iterations: number;
  toolCalls: number;
  toolFailures: number;
  filesChanged: number;
  inputTokens: number;
  outputTokens: number;
  summary: string;
  lastError?: string;
}

export interface AgentRuntimeDeps {
  store: SqliteStore;
  bus: EventBus;
  tools: ToolRegistry;
  router: ModelRouterType;
  gate: ApprovalGate;
  scheduler: TaskScheduler;
  messages: MessageBus;
  memory: MemoryStore;
  contextEngineFactory: (ws: Workspace) => ContextEngine;
  projectDir: string;
  defaultAutonomy: AutonomyLevel;
  defaultPolicy: ApprovalPolicy;
  defaultModel?: ModelRef;
  defaultStrategy?: import('./router.js').RoutingStrategy;
  maxIterations?: number;
  maxTranscriptTokens?: number;
  defaultTimeoutMs?: number;
  verboseEvents?: boolean;
  instructionFiles?: string[];
}

export interface StartOptions {
  taskId?: TaskId;
  budgetTokens?: number;
  maxIterations?: number;
  model?: ModelRef;
  files?: string[];
}

const KIND = 'agent';
export const AGENT_KIND = KIND;

/** Capability group → tool names. Empty/missing capabilities = all tools. */
const CAPABILITY_TOOLS: Record<string, string[]> = {
  all: ['*'],
  filesystem: ['read_file', 'write_file', 'create_file', 'edit_file', 'delete_file', 'list_directory', 'search_files', 'search_symbols'],
  shell: ['shell'],
  git: ['git_status', 'git_diff', 'git_log', 'git_add', 'git_commit', 'git_branch'],
  tests: ['run_tests', 'run_build', 'run_linter'],
  http: ['http_request'],
  env: ['inspect_environment'],
  progress: ['report_progress'],
  comms: ['send_message'],
};

const TERMINAL: AgentState[] = ['failed', 'completed', 'cancelled'];

export class AgentRuntime {
  private deps: AgentRuntimeDeps;
  private running = new Map<string, { controller: AbortController; paused: boolean; pauseWaiters: (() => void)[] }>();
  private maxIterations: number;
  private maxTranscriptTokens: number;

  constructor(deps: AgentRuntimeDeps) {
    this.deps = deps;
    this.maxIterations = deps.maxIterations ?? 25;
    this.maxTranscriptTokens = deps.maxTranscriptTokens ?? 24_000;
    if (!deps.tools.has('report_progress')) {
      deps.tools.register(
        {
          name: 'report_progress',
          description: 'Report your real progress (0-100 or null when unknown), current action, and plan steps. Call this as work advances.',
          minAutonomy: 'read-only',
          inputSchema: {
            type: 'object',
            properties: {
              progress: { type: 'number', description: '0-100 completion estimate, or omit when unknown' },
              currentAction: { type: 'string', description: 'What you are doing right now' },
              plan: { type: 'array', description: 'Plan steps with done flags', items: { type: 'object', properties: { title: { type: 'string' }, done: { type: 'boolean' } }, required: ['title', 'done'] } },
            },
            additionalProperties: false,
          },
        },
        async (input, ctx) => {
          if (!ctx.agentId) throw new ForgeError('INVALID_STATE', 'report_progress requires an agent context');
          const agent = this.get(ctx.agentId);
          if (typeof input.progress === 'number') agent.progress = Math.max(0, Math.min(100, input.progress));
          if (typeof input.currentAction === 'string') agent.currentAction = input.currentAction.slice(0, 500);
          if (Array.isArray(input.plan)) {
            agent.plan = (input.plan as { title: unknown; done: unknown }[]).slice(0, 50).map((s) => ({
              title: String(s.title ?? '').slice(0, 300),
              done: s.done === true,
            }));
            const planDone = agent.plan.filter((s) => s.done).length;
            if (agent.plan.length > 0 && agent.progress === null) agent.progress = Math.round((planDone / agent.plan.length) * 100);
          }
          agent.updatedAt = nowIso();
          this.save(agent);
          this.deps.bus.emit({
            type: 'agent.progress', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId,
            simulated: agent.simulated || undefined,
            data: { progress: agent.progress, currentAction: agent.currentAction, plan: agent.plan },
          });
          return { progress: agent.progress, currentAction: agent.currentAction, plan: agent.plan };
        },
      );
    }
    if (!deps.tools.has('send_message')) {
      deps.tools.register(
        {
          name: 'send_message',
          description: 'Send a message to another agent (by id or name) or broadcast to the team ("*"). Use for questions, status, handoffs and blocker reports.',
          minAutonomy: 'read-only',
          inputSchema: {
            type: 'object',
            required: ['to', 'body'],
            properties: {
              to: { type: 'string', description: 'Recipient agent id/name, or "*" for team broadcast' },
              type: { type: 'string', enum: ['request', 'response', 'question', 'answer', 'status', 'handoff', 'warning', 'blocked', 'approval', 'broadcast'], default: 'status' },
              subject: { type: 'string', description: 'Short subject' },
              body: { type: 'string', description: 'Message body' },
            },
            additionalProperties: false,
          },
        },
        async (input, ctx) => {
          if (!ctx.agentId) throw new ForgeError('INVALID_STATE', 'send_message requires an agent context');
          const from = this.get(ctx.agentId);
          let to = String(input.to);
          if (to !== '*') {
            // Resolve name → id so agents can address teammates by name.
            try {
              this.get(to);
            } catch {
              const match = this.list(from.sessionId).find((a) => a.name === to);
              if (!match) throw new ForgeError('NOT_FOUND', `No agent with id or name '${to}' in this session`);
              to = match.id;
            }
          }
          const msg = this.deps.messages.send({
            sessionId: from.sessionId, teamId: from.teamId, taskId: from.currentTaskId,
            from: from.id, to,
            type: (input.type as AgentMessageType | undefined) ?? (to === '*' ? 'broadcast' : 'status'),
            subject: input.subject as string | undefined,
            body: String(input.body),
          });
          return { id: msg.id, to: msg.to, type: msg.type, ts: msg.ts };
        },
      );
    }
  }

  // ------------------------------------------------------------- lifecycle ---

  createAgent(input: {
    sessionId: SessionId; name: string; role?: string; capabilities?: string[];
    model?: ModelRef; autonomy?: AutonomyLevel; policy?: ApprovalPolicy;
    parentAgentId?: AgentId; teamId?: TeamId; workspacePath?: string; goal?: string;
  }): Agent {
    if (!input.name.trim()) throw new ForgeError('INVALID_INPUT', 'Agent name must not be empty');
    const now = nowIso();
    const agent: Agent = {
      id: agentId(),
      sessionId: input.sessionId,
      name: input.name,
      role: input.role ?? 'engineer',
      capabilities: input.capabilities ?? [],
      model: input.model ?? this.deps.defaultModel,
      autonomy: input.autonomy ?? this.deps.defaultAutonomy,
      policy: input.policy ?? this.deps.defaultPolicy,
      state: 'created',
      progress: null,
      parentAgentId: input.parentAgentId,
      teamId: input.teamId,
      workspacePath: input.workspacePath,
      children: [],
      goal: input.goal,
      plan: [],
      metrics: { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, toolFailures: 0, filesChanged: 0, iterations: 0 },
      transcript: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(agent);
    this.deps.bus.emit({
      type: 'agent.created', sessionId: agent.sessionId, agentId: agent.id, teamId: agent.teamId,
      data: { name: agent.name, role: agent.role, parent: agent.parentAgentId },
    });
    if (input.parentAgentId) {
      try {
        const parent = this.get(input.parentAgentId);
        parent.children.push(agent.id);
        parent.updatedAt = nowIso();
        this.save(parent);
      } catch { /* parent vanished — child remains valid */ }
    }
    return agent;
  }

  get(id: string): Agent {
    const a = this.deps.store.getDoc<Agent>(KIND, id);
    if (!a) throw new ForgeError('NOT_FOUND', `Agent not found: ${id}`);
    return a;
  }

  list(sessionId?: string): Agent[] {
    return this.deps.store.listDocs<Agent>(KIND, sessionId);
  }

  /**
   * Run the agent loop to completion. Resolves with a measured result —
   * callers (CLI/server/orchestrator) may await it or poll agent state.
   */
  async start(id: string, goal: string, opts?: StartOptions): Promise<AgentResult> {
    const agent = this.get(id);
    if (this.running.has(id)) throw new ForgeError('INVALID_STATE', `Agent ${id} is already running`);
    if (!['created', 'idle'].includes(agent.state)) {
      throw new ForgeError('INVALID_STATE', `Cannot start agent in state '${agent.state}' (use retry for failed agents)`);
    }
    agent.goal = goal;
    if (opts?.taskId) agent.currentTaskId = opts.taskId;
    if (opts?.model) agent.model = opts.model;
    agent.metrics.startedAt = nowIso();
    agent.metrics.finishedAt = undefined;
    agent.lastError = undefined;
    this.setState(agent, 'planning');
    this.deps.bus.emit({
      type: 'agent.started', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId,
      data: { goal: goal.slice(0, 2000) },
    });

    const controller = new AbortController();
    this.running.set(id, { controller, paused: false, pauseWaiters: [] });
    try {
      const summary = await this.loop(agent, goal, opts ?? {}, controller.signal);
      this.setState(agent, 'completed');
      agent.metrics.finishedAt = nowIso();
      agent.progress = 100;
      agent.updatedAt = nowIso();
      this.save(agent);
      this.deps.bus.emit({
        type: 'agent.completed', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId,
        simulated: agent.simulated || undefined,
        data: { summary: summary.slice(0, 4000), metrics: agent.metrics },
      });
      return this.toResult(agent, summary);
    } catch (e) {
      const err = asForgeError(e);
      agent.metrics.finishedAt = nowIso();
      agent.updatedAt = nowIso();
      if (err.code === 'CANCELLED' || controller.signal.aborted) {
        agent.lastError = 'cancelled';
        this.setState(agent, 'cancelled');
        this.save(agent);
        this.deps.bus.emit({
          type: 'agent.cancelled', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId,
          data: {},
        });
        return this.toResult(agent, 'Agent run cancelled.');
      }
      agent.lastError = `${err.code}: ${err.message}`.slice(0, 2000);
      this.setState(agent, 'failed');
      this.save(agent);
      this.deps.bus.emit({
        type: 'agent.failed', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId,
        simulated: agent.simulated || undefined,
        data: { error: { code: err.code, message: err.message } },
      });
      return this.toResult(agent, '', err.message);
    } finally {
      this.running.delete(id);
    }
  }

  pause(id: string): Agent {
    const run = this.running.get(id);
    if (!run) throw new ForgeError('INVALID_STATE', `Agent ${id} is not running`);
    run.paused = true;
    const agent = this.get(id);
    this.setState(agent, 'paused');
    this.save(agent);
    this.deps.bus.emit({ type: 'agent.paused', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId, data: {} });
    return agent;
  }

  resume(id: string): Agent {
    const run = this.running.get(id);
    if (!run) throw new ForgeError('INVALID_STATE', `Agent ${id} is not running`);
    if (!run.paused) return this.get(id);
    run.paused = false;
    for (const w of run.pauseWaiters.splice(0)) w();
    const agent = this.get(id);
    this.setState(agent, 'executing');
    this.save(agent);
    this.deps.bus.emit({ type: 'agent.resumed', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId, data: {} });
    return agent;
  }

  cancel(id: string): Agent {
    const run = this.running.get(id);
    const agent = this.get(id);
    if (run) {
      run.controller.abort();
      run.paused = false;
      for (const w of run.pauseWaiters.splice(0)) w();
    } else if (!TERMINAL.includes(agent.state)) {
      this.setState(agent, 'cancelled');
      this.save(agent);
    }
    return this.get(id);
  }

  /** Ids of agents with an active run loop (for shutdown/restore coordination). */
  runningIds(): string[] {
    return [...this.running.keys()];
  }

  async retry(id: string, goal?: string): Promise<AgentResult> {
    const agent = this.get(id);
    if (!['failed', 'cancelled', 'blocked'].includes(agent.state)) {
      throw new ForgeError('INVALID_STATE', `Cannot retry agent in state '${agent.state}'`);
    }
    agent.state = 'idle';
    agent.lastError = undefined;
    agent.updatedAt = nowIso();
    this.save(agent);
    return this.start(id, goal ?? agent.goal ?? '');
  }

  setTask(id: string, taskId: TaskId | undefined): Agent {
    const agent = this.get(id);
    agent.currentTaskId = taskId;
    agent.updatedAt = nowIso();
    this.save(agent);
    return agent;
  }

  // ------------------------------------------------------------- subagents ---

  /**
   * Spawn a child agent. The child inherits ONLY the explicit delegation
   * (objective + optional summary/files) — never the parent's transcript.
   */
  spawnSubagent(parentId: string, input: {
    name: string; role?: string; goal: string; parentSummary?: string;
    files?: string[]; capabilities?: string[]; model?: ModelRef; autonomy?: AutonomyLevel;
  }): Agent {
    const parent = this.get(parentId);
    const child = this.createAgent({
      sessionId: parent.sessionId,
      name: input.name,
      role: input.role ?? 'subagent',
      capabilities: input.capabilities ?? parent.capabilities,
      model: input.model ?? parent.model,
      autonomy: input.autonomy ?? parent.autonomy,
      policy: parent.policy,
      parentAgentId: parent.id,
      teamId: parent.teamId,
      workspacePath: parent.workspacePath,
      goal: input.goal,
    });
    // Seed the child's first user turn with the explicit delegation only.
    const parts = [`Delegated objective from ${parent.name} (${parent.role}):`, input.goal];
    if (input.parentSummary) parts.push(`\nParent context summary:\n${input.parentSummary.slice(0, 4000)}`);
    if (input.files?.length) parts.push(`\nRelevant files:\n${input.files.join('\n')}`);
    child.transcript = [{ role: 'user', content: parts.join('\n') }];
    child.updatedAt = nowIso();
    this.save(child);
    return child;
  }

  // ------------------------------------------------------------- messaging ---

  sendMessage(fromId: string, to: string, type: AgentMessageType, body: string, opts?: { subject?: string; taskId?: TaskId }): ReturnType<MessageBus['send']> {
    const from = this.get(fromId);
    return this.deps.messages.send({
      sessionId: from.sessionId, teamId: from.teamId, taskId: opts?.taskId ?? from.currentTaskId,
      from: from.id, to, type, subject: opts?.subject, body,
    });
  }

  inbox(id: string, limit = 200): ReturnType<MessageBus['inbox']> {
    const agent = this.get(id);
    return this.deps.messages.inbox(agent.sessionId, agent.id, limit);
  }

  /** Block (cooperatively) until a matching message arrives or timeout. */
  async waitForMessage(id: string, opts?: { from?: string; type?: AgentMessageType; timeoutMs?: number }): Promise<import('./messaging.js').AgentMessage | undefined> {
    const agent = this.get(id);
    const prevState = agent.state;
    this.setState(agent, 'waiting_for_agent');
    this.save(agent);
    this.deps.bus.emit({ type: 'agent.waiting', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId, data: { waitingFor: opts?.from ?? 'any' } });
    const deadline = Date.now() + (opts?.timeoutMs ?? 300_000);
    const isNew = (m: { ts: string; id: string }): boolean => {
      const cur = this.get(id);
      if (!cur.lastReadTs) return true;
      if (m.ts > cur.lastReadTs) return true;
      if (m.ts === cur.lastReadTs && (!cur.lastReadId || m.id > cur.lastReadId)) return true;
      return false;
    };
    try {
      while (Date.now() < deadline) {
        const run = this.running.get(id);
        if (run?.controller.signal.aborted) return undefined;
        const match = this.inbox(id).filter(isNew).find((m) =>
          (!opts?.from || m.from === opts.from) && (!opts?.type || m.type === opts.type));
        if (match) {
          const cur = this.get(id);
          cur.lastReadTs = match.ts;
          cur.lastReadId = match.id;
          cur.updatedAt = nowIso();
          this.save(cur);
          return match;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return undefined;
    } finally {
      const cur = this.get(id);
      if (cur.state === 'waiting_for_agent') {
        this.setState(cur, prevState === 'waiting_for_agent' ? 'executing' : prevState);
        this.save(cur);
      }
    }
  }

  handoff(taskId: TaskId, fromId: string, toId: string, note: string): void {
    const from = this.get(fromId);
    const to = this.get(toId);
    this.deps.scheduler.setOwner(taskId, to.id);
    this.deps.messages.send({
      sessionId: from.sessionId, teamId: from.teamId, taskId,
      from: from.id, to: to.id, type: 'handoff', subject: `Handoff: ${taskId}`, body: note,
    });
    this.deps.bus.emit({
      type: 'agent.message.sent', sessionId: from.sessionId, agentId: from.id, taskId, teamId: from.teamId,
      data: { handoff: true, from: from.id, to: to.id, note },
    });
  }

  // ------------------------------------------------------------------ loop ---

  private toolsFor(agent: Agent): ToolSpec[] {
    const all = this.deps.tools.list();
    if (agent.capabilities.length === 0 || agent.capabilities.includes('all')) {
      return all.map((d) => ({ name: d.name, description: d.description, inputSchema: toJsonSchema(d.inputSchema) }));
    }
    const allowed = new Set<string>(['report_progress']);
    for (const cap of agent.capabilities) {
      for (const t of CAPABILITY_TOOLS[cap] ?? []) {
        if (t === '*') return all.map((d) => ({ name: d.name, description: d.description, inputSchema: toJsonSchema(d.inputSchema) }));
        allowed.add(t);
      }
    }
    return all.filter((d) => allowed.has(d.name))
      .map((d) => ({ name: d.name, description: d.description, inputSchema: toJsonSchema(d.inputSchema) }));
  }

  private workspaceFor(agent: Agent): Workspace {
    return new Workspace({
      root: agent.workspacePath ?? this.deps.projectDir,
      sessionId: agent.sessionId,
      agentId: agent.id,
      taskId: agent.currentTaskId,
      bus: this.deps.bus,
      store: this.deps.store,
      instructionFiles: this.deps.instructionFiles,
    });
  }

  private async loop(agent: Agent, goal: string, opts: StartOptions, signal: AbortSignal): Promise<string> {
    const maxIterations = opts.maxIterations ?? this.maxIterations;
    const ws = this.workspaceFor(agent);
    const engine = this.deps.contextEngineFactory(ws);

    // Turn 0: repository inspection + instruction loading (real context).
    const built = await engine.buildForTask({
      goal,
      taskDescription: agent.currentTaskId ? this.describeTask(agent.currentTaskId) : undefined,
      budget: opts.budgetTokens,
    });
    const { stats } = built.builder.build();
    const systemPrompt = this.buildSystemPrompt(agent, ws);
    const contextBlock = built.builder.build().items
      .filter((i) => i.kind !== 'system')
      .map((i) => `--- ${i.kind}: ${i.label} ---\n${i.content}`)
      .join('\n\n');

    const transcript: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Objective:\n${goal}\n\nWorkspace context (${formatStats(stats)}):\n${contextBlock || '(empty workspace)'}\n\nBegin. Use tools to inspect, implement, validate. Call report_progress as you advance. When the objective is complete, reply with a summary and no tool calls.` },
      ...agent.transcript.filter((m) => m.role !== 'system'),
    ];
    if (opts.files?.length) {
      transcript.push({ role: 'user', content: `Focus on these files:\n${opts.files.join('\n')}` });
    }

    this.setState(agent, 'executing');
    this.save(agent);

    let consecutiveToolFailures = 0;
    let summary = '';

    for (let i = 1; i <= maxIterations; i++) {
      await this.checkpointPause(agent.id, signal);
      if (signal.aborted) throw new ForgeError('CANCELLED', 'Agent run cancelled');
      agent.metrics.iterations = i;
      agent.currentAction = `thinking (iteration ${i}/${maxIterations})`;
      this.save(agent);

      this.compactTranscriptIfNeeded(agent, transcript);

      const tools = this.toolsFor(agent);
      let res: ChatResponse;
      try {
        res = await this.deps.router.chat(
          {
            strategy: this.deps.defaultStrategy,
            preferred: agent.model ?? this.deps.defaultModel,
            requiredCapabilities: ['text', 'tool_calling'],
            agentRole: agent.role,
            sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId,
          },
          { messages: transcript, tools, temperature: 0.2, signal },
        );
      } catch (e) {
        const err = asForgeError(e);
        if (err.code === 'CANCELLED') throw err;
        throw new ForgeError(err.code === 'NO_PROVIDER' ? 'NO_PROVIDER' : 'MODEL_FAILED',
          `Model request failed: ${err.message}`, { cause: e });
      }

      agent.metrics.modelCalls++;
      agent.metrics.inputTokens += res.usage.inputTokens;
      agent.metrics.outputTokens += res.usage.outputTokens;
      if (res.simulated) agent.simulated = true;

      transcript.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls.length > 0 ? res.toolCalls : undefined });

      if (res.toolCalls.length === 0) {
        summary = res.content;
        break;
      }

      this.setState(agent, 'waiting_for_tool');
      this.save(agent);
      let allOk = true;
      const filesBefore = agent.metrics.filesChanged;
      for (const call of res.toolCalls) {
        await this.checkpointPause(agent.id, signal);
        if (signal.aborted) throw new ForgeError('CANCELLED', 'Agent run cancelled');
        agent.currentAction = `tool: ${call.name}`;
        this.save(agent);
        this.deps.bus.emit({
          type: 'agent.action', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId,
          simulated: agent.simulated || undefined,
          data: { action: agent.currentAction, iteration: i },
        });
        const base: ToolContextBase = {
          sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId,
          workspace: ws, autonomy: agent.autonomy, policy: agent.policy, gate: this.deps.gate,
          bus: this.deps.bus, signal, defaultTimeoutMs: this.deps.defaultTimeoutMs,
          verboseEvents: this.deps.verboseEvents,
        };
        const out = await this.deps.tools.invoke(call.name, call.input, base);
        agent.metrics.toolCalls++;
        if (['write_file', 'create_file', 'edit_file', 'delete_file'].includes(call.name) && out.ok) {
          agent.metrics.filesChanged++;
        }
        if (!out.ok) {
          agent.metrics.toolFailures++;
          consecutiveToolFailures++;
          allOk = false;
        } else {
          consecutiveToolFailures = 0;
        }
        transcript.push({
          role: 'tool', toolCallId: call.id, name: call.name,
          content: out.ok
            ? `OK (${out.durationMs}ms):\n${clip(JSON.stringify(out.result), 6000)}`
            : `FAILED [${out.error?.code}] (${out.durationMs}ms): ${out.error?.message}`,
        });
        // Persist transcript incrementally (bounded) so resume/observability work.
        agent.transcript = transcript.filter((m) => m.role !== 'system').slice(-200);
        this.save(agent);
      }
      void filesBefore;
      this.setState(agent, 'executing');
      agent.updatedAt = nowIso();
      this.save(agent);

      if (!allOk) {
        this.deps.bus.emit({
          type: 'agent.progress', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId,
          simulated: agent.simulated || undefined,
          data: { iteration: i, toolCalls: agent.metrics.toolCalls, toolFailures: agent.metrics.toolFailures, note: 'some tools failed; agent is recovering' },
        });
      }
      if (consecutiveToolFailures >= 5) {
        this.setState(agent, 'blocked');
        agent.lastError = 'blocked: 5 consecutive tool failures';
        this.save(agent);
        this.deps.bus.emit({
          type: 'agent.blocked', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId,
          simulated: agent.simulated || undefined,
          data: { reason: agent.lastError },
        });
        throw new ForgeError('TOOL_FAILED', agent.lastError);
      }
      summary = res.content;
    }

    agent.transcript = transcript.filter((m) => m.role !== 'system').slice(-200);
    agent.updatedAt = nowIso();
    this.save(agent);
    return summary || '(agent produced no summary)';
  }

  private describeTask(taskId: TaskId): string | undefined {
    try {
      const t = this.deps.scheduler.get(taskId);
      return `Task ${t.id}: ${t.title}\n${t.description}`;
    } catch {
      return undefined;
    }
  }

  private buildSystemPrompt(agent: Agent, ws: Workspace): string {
    return [
      `You are ${agent.name}, a ${agent.role} in the Forge engineering runtime.`,
      `Workspace root: ${ws.root}`,
      `Autonomy: ${agent.autonomy}. Approval policy: ${agent.policy}.`,
      'Rules:',
      '- Inspect before changing. Prefer search_files/list_directory/read_file over guessing paths.',
      '- Make minimal, correct edits. Verify with run_tests/run_build/run_linter when relevant.',
      '- Never invent file contents, test results, or tool output. Only report what tools returned.',
      '- Call report_progress as work advances (progress 0-100 or omit when unknown).',
      '- When the objective is complete (or truly blocked), reply with a concise summary and NO tool calls.',
      '- If blocked, explain exactly what is missing so a human or teammate can unblock you.',
    ].join('\n');
  }

  private compactTranscriptIfNeeded(agent: Agent, transcript: ChatMessage[]): void {
    let tokens = transcript.reduce((n, m) => n + estimateTokens(m.content) + 8, 0);
    if (tokens <= this.maxTranscriptTokens) return;
    // Keep first user turn + last 6 turns; compact middle tool outputs.
    const head = transcript.slice(0, 2);
    const tail = transcript.slice(-6);
    const middle = transcript.slice(2, -6);
    let removed = 0;
    for (const m of middle) {
      if (tokens <= this.maxTranscriptTokens * 0.7) break;
      if (m.role === 'tool' && m.content.length > 800) {
        tokens -= estimateTokens(m.content);
        m.content = m.content.slice(0, 800) + '\n…[compacted]…';
        tokens += estimateTokens(m.content);
        removed++;
      }
    }
    void head;
    void tail;
    this.deps.bus.emit({
      type: 'context.compacted', sessionId: agent.sessionId, agentId: agent.id, taskId: agent.currentTaskId, teamId: agent.teamId,
      data: { removedToolOutputs: removed, tokens },
    });
  }

  private async checkpointPause(id: string, signal: AbortSignal): Promise<void> {
    const run = this.running.get(id);
    if (!run || !run.paused) return;
    await new Promise<void>((resolvePromise, reject) => {
      run.pauseWaiters.push(resolvePromise);
      signal.addEventListener('abort', () => reject(new ForgeError('CANCELLED', 'Agent run cancelled')), { once: true });
    });
  }

  private setState(agent: Agent, state: AgentState): void {
    agent.state = state;
    agent.updatedAt = nowIso();
  }

  private save(agent: Agent): void {
    this.deps.store.putDoc(KIND, agent.id, agent.sessionId, agent.updatedAt, agent);
  }

  private toResult(agent: Agent, summary: string, error?: string): AgentResult {
    return {
      agentId: agent.id,
      state: agent.state,
      iterations: agent.metrics.iterations,
      toolCalls: agent.metrics.toolCalls,
      toolFailures: agent.metrics.toolFailures,
      filesChanged: agent.metrics.filesChanged,
      inputTokens: agent.metrics.inputTokens,
      outputTokens: agent.metrics.outputTokens,
      summary,
      lastError: error,
    };
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]…` : s;
}

