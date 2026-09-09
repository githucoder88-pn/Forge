# Memory & context engine

## Memory scopes

`memory.set --scope <scope> --key <k> --value <v>`:

| Scope | Visibility | Persisted |
|---|---|---|
| `global` | all sessions | yes |
| `project` | sessions in workspace | yes |
| `session` | one session | yes |
| `agent` | one agent (+children) | yes |
| `task` | one task | yes (until task GC) |

Retrieval merges narrow→broad with narrowest winning; entries can be
**pinned** (always included) or left to relevance ranking. `memory.search`
finds entries by keyword for agents and users.

## Context engine

`context.preview --agent <id>` shows exactly what the model sees:

1. System/role instructions (fixed)
2. Goal + task brief (fixed)
3. `AGENTS.md` project + user instructions (fixed)
4. Pinned memory (fixed)
5. Ranked memory + mailbox + observations (elastic — truncated by budget)
6. Workspace snapshot: open files, `git status`, recent changes (elastic)

Budgets come from session config (`context.maxTokens`); truncation keeps the
newest observations and highest-ranked memory. **All assembled prompts pass
through secret redaction** before reaching any provider.

## AGENTS.md

Project instructions live in `AGENTS.md` (workspace root, then `~/.forge/`)
— conventions, commands, forbidden paths. Forge ships an example in
`examples/AGENTS.md`. Models receive it every iteration; edits apply to the
next loop without restart.
