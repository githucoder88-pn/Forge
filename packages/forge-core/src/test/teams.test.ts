import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import { TeamManager } from '../teams.js';
import { sessionId, agentId, taskId } from '../ids.js';

describe('TeamManager', () => {
  let teams: TeamManager;
  const sess = sessionId();

  beforeEach(() => {
    teams = new TeamManager(new SqliteStore({ path: ':memory:' }));
  });

  test('membership and roles', () => {
    const t = teams.create({ sessionId: sess, name: 'eng' });
    const a = agentId();
    teams.addMember(t.id, a, 'Backend');
    assert.deepEqual(teams.get(t.id).roles, { [a]: 'Backend' });
    teams.setRole(t.id, a, 'Frontend');
    assert.equal(teams.get(t.id).roles[a], 'Frontend');
    teams.removeMember(t.id, a);
    assert.equal(teams.get(t.id).memberIds.length, 0);
  });

  test('aggregateStatus derives real progress and blockers', () => {
    const t = teams.create({ sessionId: sess, name: 'eng' });
    const a = agentId();
    const b = agentId();
    teams.addMember(t.id, a, 'Backend');
    teams.addMember(t.id, b, 'QA');
    const t1 = taskId();
    const t2 = taskId();
    teams.enqueueTask(t.id, t1);
    teams.enqueueTask(t.id, t2);
    const status = teams.aggregateStatus(
      t.id,
      [
        { id: a, role: 'Backend', state: 'executing', progress: 50, currentTaskId: t1 },
        { id: b, role: 'QA', state: 'idle', progress: null },
      ],
      [
        { id: t1, status: 'running', progress: 50, ownerAgentId: a },
        { id: t2, status: 'blocked', progress: 10, blockedBy: 'waiting on API', ownerAgentId: b },
      ],
    );
    assert.equal(status.members.length, 2);
    assert.equal(status.tasks.blocked, 1);
    assert.equal(status.blockers[0]?.reason, 'waiting on API');
    assert.equal(status.progress, 30);
  });
});
