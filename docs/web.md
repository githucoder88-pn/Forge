# Web console

Served by `forge serve` at `/app/` (zero dependencies, plain JS). Open
`http://127.0.0.1:8719/app/` after starting the server.

## Views (12)

| View | Shows |
|---|---|
| Dashboard | session goal, state counts, progress, provider health |
| Agents | roster with state, model, tokens; cancel/retry |
| Agent detail | transcript-ish observation log, tools, subagent tree |
| Tasks | DAG board by state; retry/cancel nodes |
| Teams | rosters, queues, handoffs, standups, blockers |
| Messages | channels/DMs/threads with live updates |
| Workspace | file tree + viewer; session change list |
| Validation | pipeline runs with per-step output |
| Memory | scoped entries, pinning, search |
| Checkpoints | snapshots with diff/restore |
| Models | providers, measured health, usage |
| Events | raw event stream (filterable) |

## Behavior

- Connects via RPC + WebSocket with `sinceSeq` resume — reload-safe.
- **Approval banner**: pending approvals surface globally; approve/deny
  inline (fail-closed on timeout).
- **SIMULATED badge**: any simulated model output is badged; the Models
  view explains why.
- Command palette (`Ctrl+K`): run any CLI-equivalent action by name.
- No state is invented: every number comes from a Core query or event.

## Desktop shells

Electron (`apps/forge-electron`) and Tauri (`apps/forge-tauri`) are thin
wrappers hosting the same `/app/` client — installable, auto-updating
hosts with native menus. They contain no orchestration logic.
