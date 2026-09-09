# Teams, messaging & task graphs

## Teams

A team (`teams.ts`) groups agents under roles with a shared queue:

```bash
forge run "Ship checkout v2" --team eng:backend,frontend,qa
forge teams --session <id>
forge team eng --session <id>     # roster, queue, blockers
```

- **Roles** carry default instructions + tool allow-lists (e.g. `qa` can't
  push). Roles are config-defined and extensible.
- **Handoffs:** `team.handoff` moves a task + its context summary from one
  role/agent to another; the handoff is a first-class event.
- **Standups:** `team.standup` aggregates per-agent state, current task,
  and blockers — computed from runtime state, not generated prose.
- **Blockers:** agents report blockers (`agent.report`) which surface on
  the team and session until cleared.

## Messaging

Real message passing (`teams-channels.ts`), persisted:

- `message.send --to @agent --text …` (DMs), `--channel #general` for
  channels, `--thread <id>` for threads.
- `message.read --with @agent --since <seq>` cursor-based reads; agents
  poll their mailbox each loop iteration.
- `forge watch` shows `agent.message.sent` live.

## Task graphs

`forge plan "<goal>"` produces a DAG; `forge run` executes it.

- **Dependencies:** tasks run when deps complete; independent tasks run in
  parallel (cap `maxParallel`, default 4).
- **States:** `queued → running → completed | failed | skipped | cancelled`.
- **Retries:** per-task `retries` with backoff; permanent failure propagates
  (`failed` + dependent `skipped`, run exit 1) unless `continueOnError`.
- **Cycle/deadlock detection:** validation rejects cyclic graphs with the
  offending path; scheduler detects no-progress stalls.
- **Statuses:** `forge tasks --session <id>` renders the live board;
  `task.topo` returns execution order; `task.retry` / `task.cancel` manage
  individual nodes.

Plans are data: `forge plan --json` emits the graph for review before
`forge run --plan-file plan.json` executes it.
