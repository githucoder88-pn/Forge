# CLI reference (`forge`)

`forge [--project DIR] [--json] <command> [args] [flags]`

Global flags: `--project` (workspace root), `--json` (machine output),
`--server URL` (talk to a remote server instead of embedded Core),
`--token`, `--non-interactive`, `--yes`, `--plugins DIR`.

## Commands

| Command | Purpose |
|---|---|
| `serve [--port] [--host]` | start API + events + web UI server |
| `run "<goal>" [--plan] [--team t:r1,r2] [--enhance] [--autonomy L] [--model m]` | execute a goal |
| `plan "<goal>" [--json] [--plan-file out]` | build task graph only |
| `demo [--dir]` | E2E smoke (SIMULATED models, real tools) |
| `status` / `agents` / `tasks` / `teams` | inspect session state |
| `agent <id>` / `team <name>` / `task <id>` | inspect one object |
| `message --to @a\|#ch --text …` / `read --with …` | messaging |
| `model list\|status` | providers + measured health |
| `checkpoint create\|list\|diff\|restore` | snapshots |
| `approvals` / `approve <id>` / `deny <id>` | approval gates |
| `watch --session` | live event stream (Ctrl-C to stop) |
| `logs --session [--since]` | persisted event history |
| `memory set\|get\|search` | scoped memory |
| `validate [--preset]` | run validation pipeline |
| `version` / `--help` | meta |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | completed (or read-only success) |
| 1 | failed (run/task/validation error, RPC error) |
| 2 | approval denied (fail-closed) |
| 130 | cancelled (Ctrl-C / cancel) |

## Examples

```bash
forge run "Fix the checkout race condition" --plan --autonomy supervised
forge run "Migrate to ESM" --team eng:backend,qa --enhance
forge serve --project ~/code/shop --port 8719
forge watch --session sess_abc123
forge checkpoint create pre-refactor --session sess_abc123
```
