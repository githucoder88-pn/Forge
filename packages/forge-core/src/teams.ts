/**
 * Teams: first-class groups of agents with roles, a shared goal, shared
 * context references and a task queue. Managers aggregate real progress,
 * blockers and dependencies from member state.
 */
import { AgentId, SessionId, TaskId, TeamId, nowIso, teamId } from './ids.js';
import { ForgeError } from './errors.js';
import { EventBus } from './events.js';
import type { SqliteStore } from './store.js';

export interface Team {
  id: TeamId;
  sessionId: SessionId;
  name: string;
  managerAgentId?: AgentId;
  memberIds: AgentId[];
  roles: Record<string, string>;
  sharedGoal?: string;
  sharedContext: string[];
  taskQueue: TaskId[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamStatus {
  teamId: TeamId;
  members: { agentId: string; role: string; state: string; progress: number | null; currentTask?: string }[];
  tasks: { total: number; completed: number; running: number; blocked: number; failed: number };
  progress: number | null;
  blockers: { taskId?: string; agentId?: string; reason: string }[];
}

const KIND = 'team';

export class TeamManager {
  constructor(private store: SqliteStore, private bus?: EventBus) {}

  create(input: { sessionId: SessionId; name: string; managerAgentId?: AgentId; sharedGoal?: string }): Team {
    if (!input.name.trim()) throw new ForgeError('INVALID_INPUT', 'Team name must not be empty');
    const now = nowIso();
    const team: Team = {
      id: teamId(),
      sessionId: input.sessionId,
      name: input.name,
      managerAgentId: input.managerAgentId,
      memberIds: input.managerAgentId ? [input.managerAgentId] : [],
      roles: input.managerAgentId ? { [input.managerAgentId]: 'manager' } : {},
      sharedGoal: input.sharedGoal,
      sharedContext: [],
      taskQueue: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(team);
    this.bus?.emit({ type: 'team.created', sessionId: team.sessionId, teamId: team.id, data: { name: team.name } });
    return team;
  }

  get(id: string): Team {
    const t = this.store.getDoc<Team>(KIND, id);
    if (!t) throw new ForgeError('NOT_FOUND', `Team not found: ${id}`);
    return t;
  }

  list(sessionId?: string): Team[] {
    return this.store.listDocs<Team>(KIND, sessionId);
  }

  addMember(id: string, agentId: AgentId, role = 'member'): Team {
    const t = this.get(id);
    if (!t.memberIds.includes(agentId)) t.memberIds.push(agentId);
    t.roles[agentId] = role;
    t.updatedAt = nowIso();
    this.save(t);
    this.bus?.emit({ type: 'team.updated', sessionId: t.sessionId, teamId: t.id, data: { action: 'member.added', agentId, role } });
    return t;
  }

  removeMember(id: string, agentId: AgentId): Team {
    const t = this.get(id);
    t.memberIds = t.memberIds.filter((m) => m !== agentId);
    delete t.roles[agentId];
    if (t.managerAgentId === agentId) t.managerAgentId = undefined;
    t.updatedAt = nowIso();
    this.save(t);
    this.bus?.emit({ type: 'team.updated', sessionId: t.sessionId, teamId: t.id, data: { action: 'member.removed', agentId } });
    return t;
  }

  setRole(id: string, agentId: AgentId, role: string): Team {
    const t = this.get(id);
    if (!t.memberIds.includes(agentId)) throw new ForgeError('NOT_FOUND', `Agent ${agentId} is not a member of team ${id}`);
    t.roles[agentId] = role;
    t.updatedAt = nowIso();
    this.save(t);
    this.bus?.emit({ type: 'team.updated', sessionId: t.sessionId, teamId: t.id, data: { action: 'role.changed', agentId, role } });
    return t;
  }

  setManager(id: string, agentId: AgentId | undefined): Team {
    const t = this.get(id);
    if (agentId && !t.memberIds.includes(agentId)) {
      t.memberIds.push(agentId);
      t.roles[agentId] = 'manager';
    }
    t.managerAgentId = agentId;
    t.updatedAt = nowIso();
    this.save(t);
    this.bus?.emit({ type: 'team.updated', sessionId: t.sessionId, teamId: t.id, data: { action: 'manager.changed', agentId } });
    return t;
  }

  enqueueTask(id: string, taskId: TaskId): Team {
    const t = this.get(id);
    if (!t.taskQueue.includes(taskId)) t.taskQueue.push(taskId);
    t.updatedAt = nowIso();
    this.save(t);
    this.bus?.emit({ type: 'team.updated', sessionId: t.sessionId, teamId: t.id, data: { action: 'task.enqueued', taskId } });
    return t;
  }

  shareContext(id: string, entry: string): Team {
    const t = this.get(id);
    t.sharedContext.push(entry);
    t.updatedAt = nowIso();
    this.save(t);
    return t;
  }

  /**
   * Aggregate team status from live agent/task snapshots supplied by the
   * runtime (teams never track shadow copies of member state).
   */
  aggregateStatus(
    id: string,
    agents: { id: string; role: string; state: string; progress: number | null; currentTaskId?: string }[],
    tasks: { id: string; status: string; progress: number | null; blockedBy?: string; ownerAgentId?: string }[],
  ): TeamStatus {
    const t = this.get(id);
    const memberSet = new Set<string>(t.memberIds);
    const members = agents
      .filter((a) => memberSet.has(a.id))
      .map((a) => ({ agentId: a.id, role: t.roles[a.id] ?? a.role, state: a.state, progress: a.progress, currentTask: a.currentTaskId }));
    const queued = new Set<string>(t.taskQueue);
    const relevant = tasks.filter((x) => queued.has(x.id) || x.ownerAgentId === t.managerAgentId || (x.ownerAgentId && memberSet.has(x.ownerAgentId)));
    const byStatus = (s: string): number => relevant.filter((x) => x.status === s).length;
    const blockers = relevant
      .filter((x) => x.status === 'blocked' || x.status === 'failed')
      .map((x) => ({ taskId: x.id, agentId: x.ownerAgentId, reason: x.blockedBy ?? x.status }));
    const progresses = relevant.map((x) => x.progress).filter((p): p is number => p !== null);
    const progress = progresses.length > 0
      ? Math.round(progresses.reduce((a, b) => a + b, 0) / progresses.length)
      : (relevant.length > 0 && relevant.every((x) => x.status === 'completed') ? 100 : null);
    return {
      teamId: t.id,
      members,
      tasks: {
        total: relevant.length,
        completed: byStatus('completed'),
        running: byStatus('running'),
        blocked: byStatus('blocked'),
        failed: byStatus('failed'),
      },
      progress,
      blockers,
    };
  }

  private save(t: Team): void {
    this.store.putDoc(KIND, t.id, t.sessionId, t.updatedAt, t);
  }
}
