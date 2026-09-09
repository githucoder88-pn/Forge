# Forge Architecture

Status: **v0.1 milestone — genuine end-to-end vertical slice, tested.**

## 1. Core principle (non-negotiable)

**Core is the single source of truth.** All state — sessions, agents, tasks,
teams, messages, memory, checkpoints, events, provider health, token usage —
is owned by `@forge/core`. Clients (CLI, web, Electron, Tauri) hold zero
authoritative state: they issue protocol commands and render Core events.
If the runtime doesn't know something, the UI doesn't invent it.

## 2. Language & platform decision: TypeScript/Node (not Rust)

The original design sketch called for a Rust core. We deliberately built
**TypeScript on Node.js ≥ 22.5** instead:

1. **The agent domain is JS-shaped.** Model APIs, JSON-Schema tools, LSP-ish
   file ops, web clients — everything speaks JSON/TS. Zero binding layers.
2. **One toolchain, zero build friction.** No napi/wasm bridge, no
   cross-compilation, one `npm run build` for the whole monorepo.
3. **Ecosystem.** `node:http`, `node:sqlite`, `node:test`, workspace
   packaging — the Node 22 stdlib covers the runtime surface.
4. **Contributor velocity.** Contributors fix a bug in Core and the CLI in
   the same language, same PR, same test runner.

Compiled-language performance is not the bottleneck of an agent platform:
model latency dominates every run by orders of magnitude. We kept the Rust
spirit (explicit errors, no panics, `Result`-style returns) in TS idioms.

**Persistence: SQLite via `node:sqlite` in the default file store.**
Sessions/agents/tasks/messages/memory/events/checkpoints survive restarts
(zero-config, one file per home dir).

## 3. System map

```text
User ──► Client (CLI/Web/Electron/Tauri) ── forge/1 (JSON-RPC over HTTP,
                                                WS/SSE live stream)
                    │
                    ▼
        ┌──────────────────────┐
        │    @forge/server     │  HTTP API, auth, WebSocket/SSE fan-out,
        │  (dispatch+server)   │  static client hosting. NO orchestration.
        └──────────┬───────────┘
                   ▼
        ┌──────────────────────┐
        │     @forge/core      │  ForgeRuntime: sessions → agents/teams →
        │  (single authority)  │  tasks → router → providers → tools →
        │                      │  workspace → validation → events → store
        └──────────────────────┘
```

### Packages

| Package | Role | Depends on |
|---|---|---|
| `forge-core` | Full runtime: 22 subsystems | (node stdlib only) |
| `forge-protocol` | Versioned method catalog + types (`forge/1`) | — |
| `forge-server` | HTTP/WS/SSE transport + dispatch | core, protocol |
| `protocol-client` | Typed RPC+stream client | protocol |
| `forge-cli` | `forge` binary | core, protocol-client |
| `apps/forge-web` | Static console (0 deps, served by server) | protocol (wire) |

### Core subsystems (`packages/forge-core/src/*.ts`)

| Module | Owns |
|---|---|
| `runtime.ts` | `ForgeRuntime`: composition root, session API, autonomy policy |
| `sessions.ts` | Session lifecycle, turns, resumable state, summaries |
| `agents.ts` | Agent objects, coding loop (model→tool→observe), subagents, retries |
| `teams.ts` | Teams, roles, queues, message passing, handoffs, standups |
| `tasks.ts` | DAG scheduler: deps, topo sort, parallel run, retries, cancel |
| `router.ts` | Capability routing, retries/backoff, fallback chains, circuit breaker |
| `providers.ts` | OpenAI/Anthropic/Google/OpenRouter/Ollama/LM-Studio/echo; HTTP + health |
| `tools.ts` | Registry (JSON-Schema validation), executor, built-ins, streaming shell |
| `permissions.ts` | Autonomy levels, risk classification, approval gates |
| `workspace.ts` | Rooted file ops (no `..` escape), search, sessions/changes, checkpoints |
| `validation.ts` | Command presets, build→lint→typecheck→test pipeline |
| `context.ts` | Budgeted context assembly, relevance ranking, redaction |
| `memory.ts` | Scoped memory (global/project/session/agent/task) + pinning |
| `events.ts` | Typed event bus (history, replay, `sinceSeq`) |
| `checkpoints.ts` | Named snapshots, diff vs HEAD, restore |
| `store.ts` | SQLite persistence for sessions/agents/tasks/messages/events/memory |
| `settings.ts` | Layered config (project > user > env > default), discovery, watch |
| `teams-channels.ts` | Messaging backend (DMs, channels, threads, cursor reads) |
| `progress.ts` | Progress model (agent reports + measured deltas, honest idle) |
| `demo.ts` | End-to-end DEMO using scripted models + REAL tools |
| `plugins.ts` | Local plugin loader (trusted-code boundary) |
| `errors.ts`, `secrets.ts`, `http.ts`, `utils.ts`, `types.ts` | Cross-cutting |

## 4. The end-to-end path (milestone)

`forge run` (or protocol `runtime.run`) flows:

```text
goal ──► session.create ──► task graph (plan) ──► per-task:
  agent.spawn ──► prompt assembly (context+memory+AGENTS.md+skills)
    ──► router.complete (capability match → provider, retry, fallback)
      ──► provider HTTP call (OpenAI/Anthropic/…/Ollama, streamed)
        ──► tool-calling loop (validated, permission-gated, cancellable)
          ──► workspace mutations (rooted) ──► validation pipeline
            ──► events emitted (agent/task/tool/progress) ──► store persisted
              ──► WS/SSE fan-out to clients ──► exit code from real completion
```

CLI `run` exits **0 only when the run genuinely completes**; failures,
denied approvals, and cancellations surface as distinct non-zero codes.

## 5. Protocol (`forge/1`)

Versioned JSON-RPC: every request/response carries `protocol: 'forge/1'`;
mismatches are rejected with `PROTOCOL_MISMATCH`. 60+ methods across
namespaces (`session.*`, `agent.*`, `task.*`, `team.*`, `message.*`,
`tool.*`, `model.*`, `memory.*`, `checkpoint.*`, `events.*`, `runtime.*`,
`workspace.*`, `progress.*`, `approvals.*`, `validation.*`, `context.*`).
Long operations detach (`{accepted:true}` + id) and stream progress events.

Live updates: `events.subscribe` over WebSocket (with `sinceSeq` resume) or
SSE. Request-scoped auth: bearer token at `~/.forge/token` (0600);
loopback bypasses auth unless `FORGE_REQUIRE_AUTH=1`.

## 6. Honesty rules (enforced, tested)

- **Boot health is measured.** `ForgeRuntime.create` awaits
  `refreshProviderHealth()` — down providers report `offline`, never
  "configured".
- **Simulated output is flagged.** Demo scripted models, test doubles, and
  the explicit echo fallback always set `simulated: true`; the UI renders a
  SIMULATED badge and the model status callout.
- **Progress is measured.** The progress engine fuses agent-reported
  fractions with file/test deltas from the event stream. No writer → idle,
  honestly.
- **Exit codes are real.** Verified by test: completion=0, failed=1,
  cancelled=130, approval-denied=2.
- **No env-dependent vacuous passes.** Tool subprocesses strip
  `NODE_TEST_CONTEXT` so `node --test` behaves identically in and out of CI.

## 7. Concurrency & resource story

- Node single-threaded event loop; CPU-light orchestration, I/O-bound model
  calls. Task scheduler caps parallelism (`maxParallel`, default 4).
- Streaming: SSE/WebSocket fan-out is backpressure-simple (bounded history
  buffers); shell tools stream chunks with line caps and cancellation.
- Token budgets: per-session accounting, per-task limits, context truncation
  by budget with relevance ranking.
- SQLite WAL store: serialized writes through a single connection; safe for
  one server per home dir.

## 8. What v0.1 does NOT do (explicit gaps)

- Plugin sandboxing / remote plugins — local, fully-trusted only.
- Multi-user authN/authZ — single-user bearer token.
- Automatic rollback on regression — checkpoints are manual (API + CLI).
- Metrics UI, hosted relay, mobile clients.

## 9. Test strategy

`node:test` + `node:assert/strict`, co-located per package, real I/O in
temp dirs (no network except loopback probes with short timeouts).
Current gates: core 100/100, protocol 4/4, server 6/6, protocol-client 3/3,
CLI 5/5, web `node --check` clean. `scripts/check.sh` runs every gate.
