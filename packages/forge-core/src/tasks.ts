/**
 * DAG task graph + scheduler. Respects dependencies, runs independent
 * tasks in parallel, propagates failures, supports cancellation/retries,
 * and detects cycles and deadlocks instead of hanging.
 */
import { AgentId, SessionId, TaskId, TeamId, nowIso, taskId } from './ids.js';
import { ForgeError } from './errors.js';
import { EventBus } from './events.js';
import type { SqliteStore } from './store.js';

export type TaskStatus =
  | 'pending' | 'ready' | 'running' | 'blocked'
  | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TaskError {
  message: string;
  code?: string;
  at: string;
}

export interface Task {
  id: TaskId;
  sessionId: SessionId;
  title: string;
  description: string;
  status: TaskStatus;
  /** 0..100. null = unknown (UI must render "no estimate", never invent one). */
  priority: number;
  dependsOn: TaskId[];
  ownerAgentId?: AgentId;
  teamId?: TeamId;
  progress: number | null;
  artifacts: string[];
  errors: TaskError[];
  retries: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  blockedBy?: string;
}

export interface TaskExecutorContext {
  signal: AbortSignal;
  reportProgress: (progress: number | null, note?: string) => void;
}

export type TaskExecutor = (task: Task, ctx: TaskExecutorContext) => Promise<{ artifacts?: string[] }>;

export interface RunOptions {
  maxParallel?: number;
  signal?: AbortSignal;
  /** Only run these tasks (and their required ordering); default: all runnable. */
  only?: TaskId[];
}

const KIND = 'task';
const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];

export class TaskScheduler {
  private running = new Map<string, AbortController>();
  private pausedAll = false;

  constructor(private store: SqliteStore, private bus?: EventBus) {}

  create(input: {
    sessionId: SessionId; title: string; description?: string; priority?: number;
    dependsOn?: TaskId[]; ownerAgentId?: AgentId; teamId?: TeamId; maxRetries?: number;
  }): Task {
    if (!input.title.trim()) throw new ForgeError('INVALID_INPUT', 'Task title must not be empty');
    const deps = input.dependsOn ?? [];
    for (const d of deps) {
      if (!this.store.getDoc<Task>(KIND, d)) throw new ForgeError('NOT_FOUND', `Dependency task not found: ${d}`);
    }
    const now = nowIso();
    const task: Task = {
      id: taskId(),
      sessionId: input.sessionId,
      title: input.title,
      description: input.description ?? '',
      status: 'pending',
      priority: input.priority ?? 50,
      dependsOn: deps,
      ownerAgentId: input.ownerAgentId,
      teamId: input.teamId,
      progress: null,
      artifacts: [],
      errors: [],
      retries: 0,
      maxRetries: input.maxRetries ?? 2,
      createdAt: now,
      updatedAt: now,
    };
    this.assertNoCycle(task);
    this.save(task);
    this.bus?.emit({
      type: 'task.created', sessionId: task.sessionId, taskId: task.id, teamId: task.teamId,
      data: { title: task.title, dependsOn: task.dependsOn, priority: task.priority },
    });
    this.refresh(task.sessionId);
    return task;
  }

  get(id: string): Task {
    const t = this.store.getDoc<Task>(KIND, id);
    if (!t) throw new ForgeError('NOT_FOUND', `Task not found: ${id}`);
    return t;
  }

  list(sessionId?: string): Task[] {
    return this.store.listDocs<Task>(KIND, sessionId);
  }

  update(id: string, patch: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'dependsOn' | 'ownerAgentId' | 'teamId' | 'maxRetries' | 'progress'>>): Task {
    const t = this.get(id);
    if (TERMINAL.includes(t.status)) throw new ForgeError('INVALID_STATE', `Cannot update ${t.status} task ${id}`);
    Object.assign(t, patch);
    if (patch.dependsOn) {
      for (const d of patch.dependsOn) {
        if (!this.store.getDoc<Task>(KIND, d)) throw new ForgeError('NOT_FOUND', `Dependency task not found: ${d}`);
      }
      this.assertNoCycle(t);
    }
    t.updatedAt = nowIso();
    this.save(t);
    this.bus?.emit({ type: 'task.updated', sessionId: t.sessionId, taskId: t.id, teamId: t.teamId, data: { patch } });
    this.refresh(t.sessionId);
    return t;
  }

  /** Re-evaluate pending/ready/blocked states from dependency status. */
  refresh(sessionId: string): void {
    const tasks = this.list(sessionId);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      if (t.status !== 'pending' && t.status !== 'ready' && t.status !== 'blocked') continue;
      const depStates = t.dependsOn.map((d) => byId.get(d)?.status ?? 'completed');
      if (depStates.some((s) => s === 'failed')) {
        const blocker = t.dependsOn.find((d) => byId.get(d)?.status === 'failed');
        this.transition(t, 'blocked', { blockedBy: `dependency ${blocker} failed` });
      } else if (depStates.some((s) => s === 'cancelled')) {
        const blocker = t.dependsOn.find((d) => byId.get(d)?.status === 'cancelled');
        this.transition(t, 'blocked', { blockedBy: `dependency ${blocker} was cancelled` });
      } else if (depStates.every((s) => s === 'completed')) {
        if (t.status !== 'ready') this.transition(t, 'ready');
      } else {
        if (t.status !== 'pending') this.transition(t, 'pending', { blockedBy: undefined });
      }
    }
  }

  cancel(id: string): Task {
    const t = this.get(id);
    if (TERMINAL.includes(t.status)) return t;
    this.running.get(id)?.abort();
    this.running.delete(id);
    this.transition(t, 'cancelled');
    this.bus?.emit({ type: 'task.cancelled', sessionId: t.sessionId, taskId: t.id, teamId: t.teamId, data: {} });
    this.refresh(t.sessionId);
    return t;
  }

  pause(id: string): Task {
    const t = this.get(id);
    if (t.status === 'running') this.running.get(id)?.abort();
    if (!TERMINAL.includes(t.status)) this.transition(t, 'paused');
    return t;
  }

  resume(id: string): Task {
    const t = this.get(id);
    if (t.status !== 'paused' && t.status !== 'blocked') throw new ForgeError('INVALID_STATE', `Cannot resume ${t.status} task`);
    this.transition(t, 'pending');
    this.refresh(t.sessionId);
    return t;
  }

  retry(id: string): Task {
    const t = this.get(id);
    if (t.status !== 'failed' && t.status !== 'cancelled' && t.status !== 'blocked') {
      throw new ForgeError('INVALID_STATE', `Cannot retry ${t.status} task`);
    }
    t.retries = 0;
    t.errors = [];
    t.progress = null;
    this.transition(t, 'pending');
    this.bus?.emit({ type: 'task.retried', sessionId: t.sessionId, taskId: t.id, teamId: t.teamId, data: {} });
    this.refresh(t.sessionId);
    return t;
  }

  setOwner(id: string, ownerAgentId: AgentId | undefined): Task {
    const t = this.get(id);
    t.ownerAgentId = ownerAgentId;
    t.updatedAt = nowIso();
    this.save(t);
    this.bus?.emit({ type: 'task.updated', sessionId: t.sessionId, taskId: t.id, teamId: t.teamId, data: { ownerAgentId } });
    return t;
  }

  /**
   * Run all runnable tasks to quiescence. Independent tasks run in parallel
   * up to maxParallel. Throws DEADLOCK if tasks remain but none can proceed.
   */
  async runAll(sessionId: string, executor: TaskExecutor, opts?: RunOptions): Promise<Task[]> {
    const maxParallel = Math.max(1, opts?.maxParallel ?? 4);
    const only = opts?.only ? new Set(opts.only) : undefined;
    const inFlight = new Map<string, Promise<void>>();

    const runnable = (): Task[] => this.list(sessionId)
      .filter((t) => (!only || only.has(t.id)) && t.status === 'ready' && !inFlight.has(t.id) && !this.running.has(t.id))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));

    const unfinished = (): Task[] => this.list(sessionId)
      .filter((t) => (!only || only.has(t.id)) && !TERMINAL.includes(t.status) && t.status !== 'paused');

    while (true) {
      if (opts?.signal?.aborted) throw new ForgeError('CANCELLED', 'Task run cancelled');
      if (this.pausedAll) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      this.refresh(sessionId);
      for (const t of runnable()) {
        if (inFlight.size >= maxParallel) break;
        inFlight.set(t.id, this.executeOne(t.id, executor, opts?.signal));
      }
      if (inFlight.size === 0) {
        const left = unfinished();
        if (left.length === 0) break;
        // Blocked tasks with failed deps are legitimately stuck — surface, don't hang.
        const stuck = left.filter((t) => t.status === 'blocked');
        const waiting = left.filter((t) => t.status !== 'blocked');
        if (waiting.length === 0) break; // only blocked remain
        throw new ForgeError('DEADLOCK',
          `Deadlock: ${waiting.length} task(s) cannot proceed (${waiting.map((t) => `${t.id} [${t.status}] deps=${t.dependsOn.join(',') || 'none'}`).join('; ')})`,
          { details: { stuck: stuck.map((t) => t.id), waiting: waiting.map((t) => t.id) } });
      }
      await Promise.race([...inFlight.values()]);
      for (const [id, p] of [...inFlight]) {
        // Drop settled promises (they remove themselves via finally below).
        void p.catch(() => undefined);
        if (!this.running.has(id)) inFlight.delete(id);
      }
    }
    return this.list(sessionId);
  }

  private async executeOne(id: string, executor: TaskExecutor, parentSignal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    this.running.set(id, controller);
    try {
      const t = this.get(id);
      this.transition(t, 'running', { startedAt: nowIso() });
      this.bus?.emit({ type: 'task.started', sessionId: t.sessionId, taskId: t.id, teamId: t.teamId, data: { title: t.title, attempt: t.retries + 1 } });
      const ctx: TaskExecutorContext = {
        signal: controller.signal,
        reportProgress: (progress, note) => {
          const cur = this.get(id);
          cur.progress = progress;
          cur.updatedAt = nowIso();
          this.save(cur);
          this.bus?.emit({ type: 'task.updated', sessionId: cur.sessionId, taskId: cur.id, teamId: cur.teamId, data: { progress, note } });
        },
      };
      const out = await executor(t, ctx);
      const done = this.get(id);
      done.artifacts.push(...(out.artifacts ?? []));
      done.progress = 100;
      this.transition(done, 'completed', { completedAt: nowIso() });
      this.bus?.emit({ type: 'task.completed', sessionId: done.sessionId, taskId: done.id, teamId: done.teamId, data: { artifacts: done.artifacts } });
    } catch (e) {
      const err = e as ForgeError;
      const t = this.get(id);
      t.errors.push({ message: err.message ?? String(e), code: (err as { code?: string }).code, at: nowIso() });
      if (controller.signal.aborted || err.code === 'CANCELLED') {
        this.transition(t, 'cancelled');
        this.bus?.emit({ type: 'task.cancelled', sessionId: t.sessionId, taskId: t.id, teamId: t.teamId, data: { reason: 'cancelled' } });
      } else if (t.retries < t.maxRetries) {
        t.retries++;
        t.updatedAt = nowIso();
        this.save(t);
        this.transition(t, 'pending');
        this.bus?.emit({ type: 'task.retried', sessionId: t.sessionId, taskId: t.id, teamId: t.teamId, data: { attempt: t.retries, maxRetries: t.maxRetries, error: err.message } });
      } else {
        this.transition(t, 'failed', { completedAt: nowIso() });
        this.bus?.emit({ type: 'task.failed', sessionId: t.sessionId, taskId: t.id, teamId: t.teamId, data: { errors: t.errors } });
      }
    } finally {
      parentSignal?.removeEventListener('abort', onParentAbort);
      this.running.delete(id);
      try { this.refresh(this.get(id).sessionId); } catch { /* task deleted mid-run */ }
    }
  }

  private transition(t: Task, status: TaskStatus, extra?: Partial<Task>): void {
    t.status = status;
    if (extra) Object.assign(t, extra);
    if (status !== 'blocked') t.blockedBy = undefined;
    t.updatedAt = nowIso();
    this.save(t);
  }

  private save(t: Task): void {
    this.store.putDoc(KIND, t.id, t.sessionId, t.updatedAt, t);
  }

  /** DFS cycle detection over the session graph including the candidate. */
  private assertNoCycle(candidate: Task): void {
    const tasks = this.list(candidate.sessionId).filter((t) => t.id !== candidate.id);
    tasks.push(candidate);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const dfs = (id: TaskId, path: string[]): void => {
      if (visiting.has(id)) {
        throw new ForgeError('DEPENDENCY_CYCLE', `Dependency cycle detected: ${[...path, id].join(' → ')}`, { details: { cycle: [...path, id] } });
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of byId.get(id)?.dependsOn ?? []) {
        if (byId.has(dep)) dfs(dep, [...path, id]);
      }
      visiting.delete(id);
      visited.add(id);
    };
    dfs(candidate.id, []);
  }

  /** Topological order (dependencies first). Throws DEPENDENCY_CYCLE on cycles. */
  topoOrder(sessionId: string): Task[] {
    const tasks = this.list(sessionId);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const out: Task[] = [];
    const dfs = (t: Task, path: string[]): void => {
      if (visited.has(t.id)) return;
      if (visiting.has(t.id)) throw new ForgeError('DEPENDENCY_CYCLE', `Dependency cycle: ${[...path, t.id].join(' → ')}`);
      visiting.add(t.id);
      for (const dep of t.dependsOn) {
        const d = byId.get(dep);
        if (d) dfs(d, [...path, t.id]);
      }
      visiting.delete(t.id);
      visited.add(t.id);
      out.push(t);
    };
    for (const t of tasks) dfs(t, []);
    return out;
  }
}
