/**
 * JSON-RPC dispatch: every protocol method bound to the Core runtime.
 * Long-running operations (agent.start, task.run, runtime.run) detach and
 * report through the event stream + state queries — RPC never hangs.
 */
import {
  AgentId, AgentMessageType, AutonomyLevel, ForgeError, ForgeRuntime, SessionId,
  TaskId, TeamId, ContextEngine, matches, runDemo,
} from '@forge/core';
import {
  ForgeMethod, ProtocolError, RPC_ERROR, failure, isForgeMethod, success,
  optBoolean, optNumber, optString, optStringArray, paramsObject, reqString,
  type AgentDTO, type CheckpointDTO, type JsonRpcRequest, type JsonRpcResponse,
} from '@forge/protocol';

export interface DispatchContext {
  runtime: ForgeRuntime;
}

export async function dispatch(req: JsonRpcRequest, ctx: DispatchContext): Promise<JsonRpcResponse> {
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return failure(req.id ?? null, RPC_ERROR.INVALID_REQUEST, 'Invalid JSON-RPC request');
  }
  if (!isForgeMethod(req.method)) {
    return failure(req.id ?? null, RPC_ERROR.METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
  }
  try {
    const result = await handle(req.method, req.params, ctx);
    return success(req.id, result);
  } catch (e) {
    if (e instanceof ProtocolError) return failure(req.id ?? null, e.code, e.message, e.data);
    if (e instanceof ForgeError) {
      return failure(req.id ?? null, RPC_ERROR.FORGE, e.message, { forgeCode: e.code, details: e.details, recoverable: e.recoverable });
    }
    return failure(req.id ?? null, RPC_ERROR.INTERNAL, (e as Error).message ?? 'Internal error');
  }
}

type P = Record<string, unknown>;

async function handle(method: ForgeMethod, rawParams: unknown, ctx: DispatchContext): Promise<unknown> {
  const rt = ctx.runtime;
  const p: P = rawParams === undefined ? {} : paramsObject(rawParams);

  switch (method) {
    // ------------------------------------------------------------ sessions ---
    case 'session.create': {
      const s = rt.sessions.create({
        name: optString(p, 'name'), projectDir: optString(p, 'projectDir') ?? rt.projectDir,
      });
      return s;
    }
    case 'session.resume': return rt.sessions.resume(reqString(p, 'sessionId'));
    case 'session.list': return rt.sessions.list();
    case 'session.get': return rt.sessions.get(reqString(p, 'sessionId'));
    case 'session.close': return rt.sessions.close(reqString(p, 'sessionId'));

    // -------------------------------------------------------------- agents ---
    case 'agent.create': {
      const a = rt.agents.createAgent({
        sessionId: reqString(p, 'sessionId') as SessionId,
        name: reqString(p, 'name'),
        role: optString(p, 'role'),
        capabilities: optStringArray(p, 'capabilities'),
        model: p.model as { provider: string; model: string } | undefined,
        autonomy: p.autonomy as AutonomyLevel | undefined,
        parentAgentId: optString(p, 'parentAgentId') as AgentId | undefined,
        teamId: optString(p, 'teamId') as TeamId | undefined,
        goal: optString(p, 'goal'),
      });
      rt.sessions.attach(a.sessionId, { agentId: a.id });
      return toAgentDTO(a);
    }
    case 'agent.list': return rt.agents.list(optString(p, 'sessionId')).map(toAgentDTO);
    case 'agent.get': return toAgentDTO(rt.agents.get(reqString(p, 'agentId')));
    case 'agent.start': {
      const agentId = reqString(p, 'agentId');
      const goal = reqString(p, 'goal');
      // Detached: the run reports via agent.* events and agent.get.
      void rt.agents.start(agentId, goal, {
        taskId: optString(p, 'taskId') as TaskId | undefined,
        maxIterations: optNumber(p, 'maxIterations'),
        budgetTokens: optNumber(p, 'budgetTokens'),
        model: p.model as { provider: string; model: string } | undefined,
        files: optStringArray(p, 'files'),
      }).catch((e) => rt.bus.emit({ type: 'runtime.error', sessionId: undefined, data: { message: `agent.start failed: ${(e as Error).message}` } }));
      return { accepted: true, agentId };
    }
    case 'agent.pause': return toAgentDTO(rt.agents.pause(reqString(p, 'agentId')));
    case 'agent.resume': return toAgentDTO(rt.agents.resume(reqString(p, 'agentId')));
    case 'agent.cancel': return toAgentDTO(rt.agents.cancel(reqString(p, 'agentId')));
    case 'agent.retry': {
      const agentId = reqString(p, 'agentId');
      void rt.agents.retry(agentId, optString(p, 'goal')).catch((e) => rt.bus.emit({ type: 'runtime.error', data: { message: `agent.retry failed: ${(e as Error).message}` } }));
      return { accepted: true, agentId };
    }
    case 'agent.spawn': {
      const child = rt.agents.spawnSubagent(reqString(p, 'parentAgentId'), {
        name: reqString(p, 'name'),
        role: optString(p, 'role'),
        goal: reqString(p, 'goal'),
        parentSummary: optString(p, 'parentSummary'),
        files: optStringArray(p, 'files'),
        capabilities: optStringArray(p, 'capabilities'),
        model: p.model as { provider: string; model: string } | undefined,
      });
      rt.sessions.attach(child.sessionId, { agentId: child.id });
      return toAgentDTO(child);
    }
    case 'agent.handoff': {
      rt.agents.handoff(
        reqString(p, 'taskId') as TaskId,
        reqString(p, 'fromAgentId'),
        reqString(p, 'toAgentId'),
        reqString(p, 'note'),
      );
      return { ok: true };
    }
    case 'agent.setTask': {
      const taskId = optString(p, 'taskId');
      return toAgentDTO(rt.agents.setTask(reqString(p, 'agentId'), taskId as TaskId | undefined));
    }

    // ---------------------------------------------------------------- tasks ---
    case 'task.create': {
      const t = rt.scheduler.create({
        sessionId: reqString(p, 'sessionId') as SessionId,
        title: reqString(p, 'title'),
        description: optString(p, 'description'),
        priority: optNumber(p, 'priority'),
        dependsOn: optStringArray(p, 'dependsOn') as TaskId[] | undefined,
        ownerAgentId: optString(p, 'ownerAgentId') as AgentId | undefined,
        teamId: optString(p, 'teamId') as TeamId | undefined,
        maxRetries: optNumber(p, 'maxRetries'),
      });
      rt.sessions.attach(t.sessionId, { taskId: t.id });
      return t;
    }
    case 'task.list': return rt.scheduler.list(optString(p, 'sessionId'));
    case 'task.get': return rt.scheduler.get(reqString(p, 'taskId'));
    case 'task.update': {
      return rt.scheduler.update(reqString(p, 'taskId'), {
        title: optString(p, 'title'),
        description: optString(p, 'description'),
        priority: optNumber(p, 'priority'),
        dependsOn: optStringArray(p, 'dependsOn') as TaskId[] | undefined,
        ownerAgentId: optString(p, 'ownerAgentId') as AgentId | undefined,
        teamId: optString(p, 'teamId') as TeamId | undefined,
        maxRetries: optNumber(p, 'maxRetries'),
      });
    }
    case 'task.cancel': return rt.scheduler.cancel(reqString(p, 'taskId'));
    case 'task.pause': return rt.scheduler.pause(reqString(p, 'taskId'));
    case 'task.resume': return rt.scheduler.resume(reqString(p, 'taskId'));
    case 'task.retry': return rt.scheduler.retry(reqString(p, 'taskId'));
    case 'task.setOwner': {
      const owner = optString(p, 'ownerAgentId');
      return rt.scheduler.setOwner(reqString(p, 'taskId'), owner as AgentId | undefined);
    }
    case 'task.topo': return rt.scheduler.topoOrder(reqString(p, 'sessionId'));
    case 'task.run': {
      const sessionId = reqString(p, 'sessionId');
      const only = optStringArray(p, 'only') as TaskId[] | undefined;
      const maxParallel = optNumber(p, 'maxParallel');
      void rt.scheduler.runAll(sessionId, async (task, execCtx) => {
        if (!task.ownerAgentId) throw new ForgeError('INVALID_STATE', `Task ${task.id} has no owner agent — assign one before running`);
        const owner = rt.agents.get(task.ownerAgentId);
        rt.agents.setTask(owner.id, task.id);
        execCtx.reportProgress(5, `assigned to ${owner.name}`);
        const res = await rt.agents.start(owner.id, `Task ${task.id}: ${task.title}\n${task.description}`, { taskId: task.id });
        if (execCtx.signal.aborted) throw new ForgeError('CANCELLED', 'cancelled');
        if (res.state !== 'completed') throw new ForgeError('TOOL_FAILED', `Agent ${owner.name} ended in state ${res.state}: ${res.lastError ?? 'unknown'}`);
        return {};
      }, { maxParallel, only }).catch((e) => rt.bus.emit({ type: 'runtime.error', sessionId: sessionId as SessionId, data: { message: `task.run failed: ${(e as Error).message}` } }));
      return { accepted: true, sessionId };
    }

    // ---------------------------------------------------------------- teams ---
    case 'team.create': {
      const t = rt.teams.create({
        sessionId: reqString(p, 'sessionId') as SessionId,
        name: reqString(p, 'name'),
        managerAgentId: optString(p, 'managerAgentId') as AgentId | undefined,
        sharedGoal: optString(p, 'sharedGoal'),
      });
      rt.sessions.attach(t.sessionId, { teamId: t.id });
      return t;
    }
    case 'team.list': return rt.teams.list(optString(p, 'sessionId'));
    case 'team.get': return rt.teams.get(reqString(p, 'teamId'));
    case 'team.addMember':
      return rt.teams.addMember(reqString(p, 'teamId'), reqString(p, 'agentId') as AgentId, optString(p, 'role') ?? 'member');
    case 'team.removeMember':
      return rt.teams.removeMember(reqString(p, 'teamId'), reqString(p, 'agentId') as AgentId);
    case 'team.setRole':
      return rt.teams.setRole(reqString(p, 'teamId'), reqString(p, 'agentId') as AgentId, reqString(p, 'role'));
    case 'team.setManager': {
      const m = optString(p, 'managerAgentId');
      return rt.teams.setManager(reqString(p, 'teamId'), m as AgentId | undefined);
    }
    case 'team.enqueueTask':
      return rt.teams.enqueueTask(reqString(p, 'teamId'), reqString(p, 'taskId') as TaskId);
    case 'team.status': {
      const team = rt.teams.get(reqString(p, 'teamId'));
      const agents = rt.agents.list(team.sessionId).map((a) => ({ id: a.id, role: a.role, state: a.state, progress: a.progress, currentTaskId: a.currentTaskId }));
      const tasks = rt.scheduler.list(team.sessionId).map((t) => ({ id: t.id, status: t.status, progress: t.progress, blockedBy: t.blockedBy, ownerAgentId: t.ownerAgentId }));
      return rt.teams.aggregateStatus(team.id, agents, tasks);
    }

    // ------------------------------------------------------------- messages ---
    case 'message.send': {
      return rt.messages.send({
        sessionId: optString(p, 'sessionId') as SessionId | undefined,
        teamId: optString(p, 'teamId') as TeamId | undefined,
        taskId: optString(p, 'taskId') as TaskId | undefined,
        from: reqString(p, 'from'),
        to: reqString(p, 'to'),
        type: reqString(p, 'type') as AgentMessageType,
        subject: optString(p, 'subject'),
        body: reqString(p, 'body'),
      });
    }
    case 'message.inbox':
      return rt.messages.inbox(optString(p, 'sessionId'), reqString(p, 'agentRef'), optNumber(p, 'limit') ?? 200);
    case 'message.conversation':
      return rt.messages.conversation({
        sessionId: optString(p, 'sessionId'),
        teamId: optString(p, 'teamId'),
        taskId: optString(p, 'taskId'),
        limit: optNumber(p, 'limit'),
      });

    // ----------------------------------------------------------------- tools ---
    case 'tool.list': return rt.tools.list();
    case 'tool.invoke': {
      const ws = rt.workspaceFor(
        optString(p, 'sessionId') as SessionId | undefined,
        optString(p, 'agentId') as AgentId | undefined,
        optString(p, 'taskId') as TaskId | undefined,
      );
      return rt.tools.invoke(reqString(p, 'tool'), (p.input ?? {}) as Record<string, unknown>, {
        sessionId: optString(p, 'sessionId') as SessionId | undefined,
        agentId: optString(p, 'agentId') as AgentId | undefined,
        taskId: optString(p, 'taskId') as TaskId | undefined,
        workspace: ws,
        autonomy: (optString(p, 'autonomy') as AutonomyLevel | undefined) ?? rt.config.autonomy?.default ?? 'workspace-write',
        policy: rt.config.autonomy?.approvalPolicy ?? 'on-risky-commands',
        gate: rt.gate,
        bus: rt.bus,
        defaultTimeoutMs: optNumber(p, 'timeoutMs') ?? rt.config.orchestration?.defaultTimeoutMs,
        verboseEvents: rt.config.performance?.verboseEvents,
      });
    }

    // ------------------------------------------------------------- workspace ---
    case 'workspace.read': {
      const ws = rt.workspaceFor(optString(p, 'sessionId') as SessionId | undefined);
      return { path: reqString(p, 'path'), content: ws.readFile(reqString(p, 'path'), { maxBytes: optNumber(p, 'maxBytes') }) };
    }
    case 'workspace.write': {
      const ws = rt.workspaceFor(
        optString(p, 'sessionId') as SessionId | undefined,
        optString(p, 'agentId') as AgentId | undefined,
        optString(p, 'taskId') as TaskId | undefined,
      );
      return ws.writeFile(reqString(p, 'path'), reqString(p, 'content'));
    }
    case 'workspace.list': {
      const ws = rt.workspaceFor(optString(p, 'sessionId') as SessionId | undefined);
      return {
        entries: ws.listDirectory(optString(p, 'path') ?? '.', {
          recursive: optBoolean(p, 'recursive'),
          maxEntries: optNumber(p, 'maxEntries'),
          includeHidden: optBoolean(p, 'includeHidden'),
        }),
      };
    }
    case 'workspace.search': {
      const ws = rt.workspaceFor(optString(p, 'sessionId') as SessionId | undefined);
      return {
        matches: ws.searchFiles(reqString(p, 'pattern'), {
          paths: optStringArray(p, 'paths'),
          maxResults: optNumber(p, 'maxResults'),
          regex: optBoolean(p, 'regex'),
          flags: optString(p, 'flags'),
        }),
      };
    }
    case 'workspace.symbols': {
      const ws = rt.workspaceFor(optString(p, 'sessionId') as SessionId | undefined);
      return {
        symbols: ws.searchSymbols(optString(p, 'query') ?? '', {
          paths: optStringArray(p, 'paths'),
          maxResults: optNumber(p, 'maxResults'),
          kinds: optStringArray(p, 'kinds'),
        }),
      };
    }
    case 'workspace.instructions': {
      const ws = rt.workspaceFor(optString(p, 'sessionId') as SessionId | undefined);
      return { files: ws.loadInstructions(optString(p, 'forDir') ?? '.') };
    }
    case 'workspace.history': {
      const ws = rt.workspaceFor(optString(p, 'sessionId') as SessionId | undefined);
      return { history: ws.fileHistory(reqString(p, 'path')) };
    }

    // ----------------------------------------------------------------- models ---
    case 'model.status': return rt.providerStatus();
    case 'model.refresh': return rt.refreshProviderHealth();
    case 'model.route': {
      return rt.routePreview({
        strategy: p.strategy as never,
        preferred: p.preferred as { provider: string; model: string } | undefined,
        requiredCapabilities: optStringArray(p, 'requiredCapabilities') as never,
        agentRole: optString(p, 'agentRole'),
        sessionId: optString(p, 'sessionId') as SessionId | undefined,
        agentId: optString(p, 'agentId') as AgentId | undefined,
        taskId: optString(p, 'taskId') as TaskId | undefined,
      });
    }

    // ------------------------------------------------------------ checkpoints ---
    case 'checkpoint.create': {
      const sessionId = reqString(p, 'sessionId') as SessionId;
      const ckpt = await rt.createCheckpoint(sessionId, reqString(p, 'label'));
      return toCheckpointDTO(ckpt);
    }
    case 'checkpoint.list': return rt.checkpoints.list(optString(p, 'sessionId')).map(toCheckpointDTO);
    case 'checkpoint.restore': {
      const ckpt = await rt.restoreCheckpoint(reqString(p, 'checkpointId'), {
        restoreGit: optBoolean(p, 'restoreGit'),
        allowDirtyRestore: optBoolean(p, 'allowDirtyRestore'),
      });
      return toCheckpointDTO(ckpt);
    }
    case 'checkpoint.rollback': {
      const ckpt = await rt.rollback(reqString(p, 'sessionId') as SessionId, {
        restoreGit: optBoolean(p, 'restoreGit'),
        allowDirtyRestore: optBoolean(p, 'allowDirtyRestore'),
      });
      return toCheckpointDTO(ckpt);
    }

    // -------------------------------------------------------------- approvals ---
    case 'approval.list': return rt.gate.listPending();
    case 'approval.resolve': return rt.gate.resolve(reqString(p, 'approvalId'), reqBoolean(p, 'approved'));

    // ----------------------------------------------------------------- memory ---
    case 'memory.put': {
      return rt.memory.put(
        reqString(p, 'scope') as 'global' | 'project' | 'session' | 'team' | 'agent' | 'task',
        reqString(p, 'scopeId'),
        reqString(p, 'key'),
        reqString(p, 'value'),
        optStringArray(p, 'tags') ?? [],
      );
    }
    case 'memory.get': {
      const e = rt.memory.get(
        reqString(p, 'scope') as 'global' | 'project' | 'session' | 'team' | 'agent' | 'task',
        reqString(p, 'scopeId'),
        reqString(p, 'key'),
      );
      if (!e) throw new ForgeError('NOT_FOUND', 'Memory entry not found');
      return e;
    }
    case 'memory.list':
      return rt.memory.list(
        reqString(p, 'scope') as 'global' | 'project' | 'session' | 'team' | 'agent' | 'task',
        reqString(p, 'scopeId'),
        optNumber(p, 'limit') ?? 200,
      );
    case 'memory.search':
      return rt.memory.search(reqString(p, 'query'), {
        scopes: p.scopes as { scope: 'global' | 'project' | 'session' | 'team' | 'agent' | 'task'; scopeId: string }[] | undefined,
        limit: optNumber(p, 'limit'),
      });
    case 'memory.delete': {
      rt.memory.delete(reqString(p, 'id'));
      return { ok: true };
    }

    // ---------------------------------------------------------------- context ---
    case 'context.build': {
      const ws = rt.workspaceFor(optString(p, 'sessionId') as SessionId | undefined);
      const engine = new ContextEngine({ workspace: ws, memory: rt.memory });
      const built = await engine.buildForTask({
        goal: reqString(p, 'goal'),
        taskDescription: optString(p, 'taskDescription'),
        budget: optNumber(p, 'budget'),
      });
      const { items, stats } = built.builder.build();
      return {
        stats,
        files: built.files,
        items: items.map((i) => ({ kind: i.kind, label: i.label, tokens: i.tokens, priority: i.priority, preview: i.content.slice(0, 500) })),
      };
    }

    // ----------------------------------------------------------------- events ---
    case 'events.replay': {
      return rt.store.loadEvents({
        sessionId: optString(p, 'sessionId'),
        sinceSeq: optNumber(p, 'sinceSeq'),
        types: optStringArray(p, 'types'),
        limit: optNumber(p, 'limit') ?? 500,
      });
    }

    // ---------------------------------------------------------------- runtime ---
    case 'runtime.run': {
      const session = optString(p, 'sessionId')
        ? rt.sessions.resume(optString(p, 'sessionId') as string)
        : rt.ensureSession(optString(p, 'sessionName'));
      const goal = reqString(p, 'goal');
      void rt.runGoal(goal, {
        sessionId: session.id,
        agentName: optString(p, 'agentName'),
        role: optString(p, 'role'),
        capabilities: optStringArray(p, 'capabilities'),
        model: p.model as { provider: string; model: string } | undefined,
        maxIterations: optNumber(p, 'maxIterations'),
        budgetTokens: optNumber(p, 'budgetTokens'),
        enhance: optBoolean(p, 'enhance'),
        plan: optBoolean(p, 'plan'),
        team: p.team as { name: string; roles: string[] } | undefined,
      }).catch((e) => rt.bus.emit({ type: 'runtime.error', sessionId: session.id, data: { message: `runtime.run failed: ${(e as Error).message}` } }));
      return { accepted: true, sessionId: session.id };
    }
    case 'runtime.plan': {
      const sessionId = reqString(p, 'sessionId') as SessionId;
      return rt.planGoal(sessionId, reqString(p, 'goal'), { maxTasks: optNumber(p, 'maxTasks') });
    }
    case 'runtime.enhance': {
      return rt.enhanceGoal(reqString(p, 'sessionId') as SessionId, reqString(p, 'goal'));
    }
    case 'runtime.review': {
      return rt.reviewChanges(reqString(p, 'sessionId') as SessionId, {
        agentId: optString(p, 'agentId') as AgentId | undefined,
        taskId: optString(p, 'taskId') as TaskId | undefined,
      });
    }
    case 'runtime.status': {
      const sessions = rt.sessions.list();
      return {
        projectDir: rt.projectDir,
        sessions: sessions.length,
        agents: sessions.reduce((n, s) => n + s.agentIds.length, 0),
        providers: rt.providerStatus(),
        approvals: rt.gate.pendingCount(),
        eventSeq: rt.bus.latestSeq(),
      };
    }

    // ----------------------------------------------------------------- config ---
    case 'config.get': {
      const cfg = rt.config;
      const providers: Record<string, unknown> = {};
      for (const [id, pc] of Object.entries(cfg.providers ?? {})) {
        providers[id] = {
          kind: pc.kind, baseUrl: pc.baseUrl, enabled: pc.enabled,
          hasKey: pc.apiKeyEnv ? !!process.env[pc.apiKeyEnv] : undefined,
          models: pc.models,
        };
      }
      return {
        project: cfg.project,
        orchestration: cfg.orchestration,
        models: cfg.models,
        routing: cfg.routing,
        autonomy: cfg.autonomy,
        performance: cfg.performance,
        providers,
      };
    }

    // ------------------------------------------------------------------- demo ---
    case 'demo.run': {
      const demo = await runDemo({
        workDir: optString(p, 'workDir'),
        onEvent: (e) => {
          // Bridge demo events into this server's stream (new seq, flagged).
          if (matches(() => true, e)) {
            rt.bus.emit({
              type: e.type, sessionId: e.sessionId, agentId: e.agentId,
              taskId: e.taskId, teamId: e.teamId, simulated: true, data: e.data,
            });
          }
        },
      });
      return demo;
    }
  }
}

function reqBoolean(p: P, key: string): boolean {
  const v = p[key];
  if (typeof v !== 'boolean') throw new ProtocolError(RPC_ERROR.INVALID_PARAMS, `params.${key} must be a boolean`);
  return v;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…[truncated]…' : s;
}

function toAgentDTO(a: {
  id: string; sessionId: string; name: string; role: string; capabilities: string[];
  model?: { provider: string; model: string }; autonomy: string; policy: string; state: string;
  progress: number | null; currentTaskId?: string; currentAction?: string;
  parentAgentId?: string; teamId?: string; children: string[];
  plan: { title: string; done: boolean }[];
  metrics: Record<string, unknown> | unknown;
  transcript: { role: string; content: string }[];
  createdAt: string; updatedAt: string; lastError?: string; simulated?: boolean;
}): AgentDTO {
  return {
    id: a.id, sessionId: a.sessionId, name: a.name, role: a.role,
    capabilities: a.capabilities, model: a.model,
    autonomy: a.autonomy, policy: a.policy, state: a.state,
    progress: a.progress, currentTaskId: a.currentTaskId, currentAction: a.currentAction,
    parentAgentId: a.parentAgentId, teamId: a.teamId, children: a.children,
    plan: a.plan,
    metrics: { ...(a.metrics as Record<string, unknown>), transcriptLength: a.transcript.length },
    createdAt: a.createdAt, updatedAt: a.updatedAt, lastError: a.lastError,
    simulated: a.simulated || undefined,
    transcriptTail: a.transcript.slice(-10).map((m) => ({ role: m.role, content: clip(m.content, 2000) })),
  } as AgentDTO & { transcriptTail: unknown };
}

function toCheckpointDTO(c: { id: string; sessionId: string; label: string; createdAt: string; gitHead?: string; gitDirty?: boolean; eventSeq: number }): CheckpointDTO {
  return { id: c.id, sessionId: c.sessionId, label: c.label, createdAt: c.createdAt, gitHead: c.gitHead, gitDirty: c.gitDirty, eventSeq: c.eventSeq };
}
