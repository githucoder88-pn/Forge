# Agents

An agent is a runtime object (`agents.ts`) with an id, session, role,
model, autonomy ceiling, mailbox, and run state — not a prompt wrapper.

## Lifecycle

`spawn → running ⇄ waiting(approval/input) → completed | failed | cancelled`

- `agent.create` registers the agent; `agent.start` begins the loop.
- The **coding loop** repeats: assemble prompt → `router.complete` →
  execute tool calls (validated, gated) → append observations → until the
  model emits `finish` (or budget/stall limits hit).
- `agent.cancel` aborts the in-flight HTTP request AND running tools
  (AbortController chains into shell/streaming tools).
- `agent.retry` re-runs a failed agent with prior observations retained.

## Prompt assembly (per iteration)

Role instructions → session goal → task brief → `AGENTS.md` (project+user)
→ relevant memory (ranked) → mailbox messages → recent observations →
workspace snapshot. Assembled by the context engine under the session token
budget; secrets redacted; the assembly is inspectable via `context.preview`.

## Subagents & delegation

Agents spawn subagents (`agent.spawn` with `parentId`) for parallelizable
sub-goals. Children inherit session + autonomy ceiling (never exceed the
parent), report to the parent's mailbox, and their token usage rolls up.
`agent.tree` shows the hierarchy; cancelling a parent cancels descendants.

## Stall & budget guards

- **Stall detection:** N iterations with no file writes, no tool success, no
  reported progress → agent marked `stalled`, surfaced to session owner.
- **Budgets:** per-task token caps and per-session caps; exceeding pauses
  the agent with `budget-exceeded` (resumable after raising the cap).

## CLI

```bash
forge agents --session <id>     # list with state
forge agent <id>                # inspect (state, tools, tokens)
forge cancel agent <id>         # cancel
forge retry agent <id>          # retry failed
```
