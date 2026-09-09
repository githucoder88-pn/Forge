# Forge Architecture (Phase 1)

> Practical record of the system as built. For contributor workflow see
> `CONTRIBUTING.md`; for the threat model see `SECURITY.md`.

## 1. Big picture

```text
CLI / Tauri / Electron (render + request only)
        │  JSON-RPC 2.0 + WebSocket events (protocol v1)
        ▼
Forge Core (authoritative: sessions, agents, tools, models, events, permissions, state)
        │  AgentRuntime loop (model → tool calls → execute → model …)
        ▼
Workspace (jailed filesystem) · Shell · Git · Tests
        │
        ▼
SQLite (sessions, agents, messages, events, tool runs, approvals)
```

**Core principle:** clients never own task/agent/tool state and never execute
tools. Every mutation flows: `protocol → permissions → registry → execution →
event bus → persistence → clients`.

## 2. Implementation note (deviation log)

The Phase-1 brief assumed a Rust Core. This repository implements Core in
**TypeScript on Node 22** instead, because the checkout had no Rust toolchain
and a single-language monorepo delivered the complete working vertical slice
fastest. All brief invariants are preserved:

- Canonical IDs are time-sortable UUIDv7 with type-tagged prefixes
  (`sess_…`, `agent_…`, …), generated with a CSPRNG (never `Math.random`).
- The protocol is versioned (`1.0`) and transport-agnostic, so a future Rust
  Core can serve the same clients unchanged.
- Branded ID types + an explicit agent state machine + Core-enforced
  permissions match the specified semantics.

A Rust port would reimplement `packages/core` behind the identical protocol;
`packages/protocol` (schemas, IDs, errors, events) is the porting contract.

## 3. Repository layout

```text
packages/protocol   IDs, branded types, errors, events, RPC schemas (zod). No Node APIs.
packages/core       The runtime: config, logging, store, events, workspace,
                    permissions, tools, models, agent loop, sessions, server.
packages/client     Typed RPC + WebSocket client (Node + browser, zero deps).
packages/cli        `forge` binary: run/serve/session/status/agents/events/cancel.
packages/web-ui     Framework-free UI mounted by both desktop shells.
apps/tauri          Vite frontend + Tauri v2 shell (src-tauri).
apps/electron       Vite renderer + Electron main/preload.
tests/fixtures      Deterministic fixture repo (failing test the agent repairs).
tests/e2e           Full-stack acceptance tests.
```

## 4. Core lifecycle

`createApp()` (`packages/core/src/app.ts`) assembles the Core:

```text
config → logger → store(SQLite) → eventBus → toolRegistry(+builtins)
       → agentRuntime → sessionManager → [CoreServer]
```

`CoreServer` binds HTTP+WS on one port (default `127.0.0.1:8710`):

- `GET /health`, `GET /` (index), `POST /rpc` (JSON-RPC, all methods except
  live streaming), `WS /ws` (RPC + `stream_events` subscriptions).
- Optional bearer token (`FORGE_TOKEN`); without it the loopback bind is the
  trust boundary (local dev tool posture, see `SECURITY.md`).

The CLI (`forge run`) connects to `FORGE_CORE_URL` when healthy, otherwise
spawns an embedded Core in-process. GUI shells always connect to a running
Core. All three clients can inspect the same session concurrently.

## 5. Client/Core boundary

| Concern | Owner |
|---|---|
| sessions, agents, tasks, messages | Core (`session.ts`, `store.ts`) |
| agent loop, state machine | Core (`agentLoop.ts`, `agent.ts`) |
| workspace I/O, shell, git, tests | Core tools (`fsTools.ts`, `execTools.ts`) |
| model selection, prompts, tool-call parsing | Core (`models.ts`, `context.ts`) |
| permissions, approvals | Core (`permissions.ts`, registry pipeline) |
| event history, ordering, replay | Core (`eventBus.ts` + `events` table) |
| rendering, input, local prefs | clients |

Clients hold no authoritative state: initial `get_session_state` snapshot +
`stream_events` subscription, with reconnect-from-`lastSeq` catch-up.

## 6. Protocol (v1)

JSON-RPC 2.0, `protocol: "1.0"` on every response. Methods (see
`packages/protocol/src/rpc.ts` for zod schemas):

```text
health  create_session  get_session  list_sessions  resume_session
send_message  get_agent  get_session_state
read_file  write_file  edit_file  list_directory  search_files
execute_shell  git_status  git_diff  git_log  run_test  run_build
stream_events (WS only)  cancel_agent  resolve_approval
```

Errors are typed (`ForgeError`: `InvalidRequest`, `NotFound`,
`PermissionDenied`, `WorkspaceViolation`, `ToolFailure`, `ModelFailure`,
`ProviderUnavailable`, `Timeout`, `Cancelled`, `PersistenceFailure`,
`ProtocolFailure`, `Conflict`, `RateLimited`) with stable numeric codes and a
`retryable` hint. Server notifications are `{ jsonrpc: "2.0",
method: "event", params: <envelope> }`.

## 7. Session model

`Session { id, workspaceRoot, title, config{provider, model, permissions,
maxIterations}, activeAgentId, lastSeq, timestamps }`. Sessions persist in
SQLite and survive client *and* Core restarts. `send_message` reuses the idle
active agent or spawns one; concurrent runs on one session return `Conflict`.
`resume_session` returns `{ snapshot, events }` for reconnect/catch-up.

## 8. Agent state machine

```text
created → idle → planning → executing ⇄ waiting_for_tool
                                  ↘ reviewing ↗
              executing/paused/… → completed | failed | cancelled
              failed → idle (explicit retry)    paused ⇄ executing
```

Transitions are validated by `transition()` (`agent.ts`); illegal moves throw
`InvalidRequest` and leave state untouched. Every transition persists and
emits `agent.state_changed`. `Agent { id, sessionId, name, role, model,
provider, state, currentTask, workspaceId, permissions, progress, metrics,
parentAgent? }` — `parentAgent`/team/memory fields are reserved extension
points for Phase 2+ and carry no behavior yet.

## 9. Agent loop

`AgentRuntime.run(agentId, task)` (`agentLoop.ts`):

```text
load session/agent → task row → persist user msg → agent.started
loop (≤ maxIterations, ≤ maxAgentRuntimeMs):
  buildContext (bounded) → model.requested/started
  → provider.complete (streamed; model.stream throttled)
  → model.completed
  → no tool calls? persist answer → agent.completed → return summary
  → else: for each call: waiting_for_tool → registry.execute
          (permission → approval? → run w/ timeout+cancel → events)
          → record tool result → executing
on Cancelled → agent.cancelled (propagates to model stream, shell, tools)
on error     → agent.failed (typed), Core keeps serving
```

Tool calls execute **sequentially** in Phase 1 (deterministic, debuggable);
`maxConcurrentTools`/`maxShellProcesses` still bound parallelism from
concurrent RPC/agent sources. One automatic retry is done only for
`RateLimited`.

## 10. Tool system

`ToolRegistry` (`toolRegistry.ts`): each tool declares `name`, `description`,
model-facing JSON Schema `parameters`, Core-side zod `input`, `timeoutMs`,
`execute`. The pipeline — validate → `checkToolPermission` → approval gate →
semaphore → execute (timeout/cancel) → `tool.*` events → `tool_runs` row —
is the only path from model output to side effect.

Builtins (`fsTools.ts`, `execTools.ts`):

- `read_file write_file create_file edit_file delete_file list_directory search_files`
- `execute_shell` (streaming, timeout, process-group kill, output caps)
- `git_status git_diff git_log` (read-only; no destructive git in Phase 1)
- `run_tests run_build` (toolchain auto-detect: npm/pnpm/yarn/bun, cargo, go,
  pytest; detected commands are permission-vetted at execution)

File mutations emit `file.*` with diff previews. `search_files` walks the
workspace itself (skips `.git`/`node_modules`/build output, binary + size
guards, time/result bounds) — independent of the model.

## 11. Model abstraction

`ModelProvider { name, capabilities(), complete(req, onEvent) }`
(`models.ts`). `req` carries system prompt, messages, function specs, and an
`AbortSignal`; streaming yields `text`/`toolcall`/`usage` events.

- **Real provider:** `OpenAIProvider` — OpenAI-compatible chat-completions
  (OpenAI, OpenRouter, Ollama, vLLM…), SSE streaming with tool-call delta
  accumulation, full abort propagation, typed error mapping. Credentials only
  from `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`).
- **Test double:** `MockProvider` (scripted steps) and the E2E
  `GreedyRepairProvider` (reactive policy over real tool outputs). Doubles
  replace *only* the LLM; every other layer stays real.

## 12. Context engine

`buildContext()` (`context.ts`): system prompt + `AGENTS.md` chain + bounded
conversation + deduplicated tool results + current request. Token-aware
(~4 chars/token estimate), drops oldest first, reports truncation, and is
fully inspectable (returns its inputs). The repo is never bulk-loaded —
targeted inspection via tools only.

`AGENTS.md` (`agentsMd.ts`): root-first chain down to the target file's
directory (`repo/AGENTS.md`, `repo/frontend/AGENTS.md`, …), deeper files
ordered last (override on conflict). No rule language in Phase 1.

## 13. Event system

Envelope `{ id, seq, ts, protocol, sessionId, type, payload, causationId? }`.
`seq` (per-session, store-allocated) is the ordering key; `ts` is
informational. The bus fans out synchronously in-process and appends
durably; `subscribe(session, handler, afterSeq?)` replays missed events
first. ~30 event types cover sessions, agents, messages, tools, files,
models, commands, tests, and approvals (see `packages/protocol/src/events.ts`).

## 14. Persistence

`node:sqlite` (`Store`, `store.ts`), file `forge.db` (WAL) under the data dir
(`~/.forge` default, `FORGE_DATA_DIR` override). Normalized tables —
`sessions agents tasks messages events tool_runs approvals meta` — with a
`schema_version` row and migration scaffold (currently v1). Events carry
versioned JSON payloads; giant outputs are truncated before storage.

## 15. Workspace abstraction

`Workspace` (`workspace.ts`) jails every path to the session root:
normalization, NUL/`~` rejection, `..` escape → `WorkspaceViolation` before
any I/O. Reads are byte-capped; listings skip VCS/dependency dirs. The model
never sees absolute host paths unless they are inside the root.

## 16. Permission boundary

Modes `read-only | workspace-write | full-workspace`, approval policies
`always | risky-only | never` (`permissions.ts`). Every tool call and every
shell segment is vetted in Core: destructive tools need approval,
always-denied binaries (`rm`, `curl`, `ssh`, `sudo`, …) are rejected in any
mode, unknown binaries need approval (or denial when approvals are off).
Approval gates suspend execution until `resolve_approval` (or `--yes`/
`autoApprove`, or a 10-minute deny-by-default timeout). Clients enforce
nothing.

## 17. Resource limits & cancellation

Central `ResourceLimits` (config/env, §`config.ts`): concurrent tools/shells,
output bytes, request bytes, agent runtime, command timeout, iterations, file
bytes, search results. Cancellation flows `cancel_agent` RPC → per-agent
`AbortController` → `AbortSignal.any` across model fetch, tool timeout
racers, and `runProcess`, which kills the whole POSIX process group
(`detached: true`) or tree-kills on Windows — no orphaned shells or streams.

## 18. Observability

Structured JSON-line logging (`trace…error`) with `sessionId/agentId/
toolCallId/eventId/provider/model` context and secret redaction
(`redactSecrets`: `sk-*`, `api_key`, bearer tokens). No full prompts at
default levels. Client state derives from snapshot + event stream; the CLI
renders a compact event timeline.

## 19. What Phase 1 deliberately omits

Teams, swarms, subagent hierarchies, planners/DAGs, remote/distributed
workers, plugin marketplace, model routing, and a full web app. Extension
points (`parentAgent`, `teamId`, `memoryIds`, registry, provider interface,
protocol versioning) exist but carry no machinery.
