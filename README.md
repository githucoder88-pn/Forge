# Forge

An open-source AI engineering platform. **Phase 1** delivers the first real,
end-to-end coding-agent runtime: a user issues a coding request against a real
repository, and Forge inspects, edits, tests, observes, and repairs — with a
real model, real tools, and a real event stream.

```bash
forge run "Fix the failing test in this repository"
```

## How it works

```text
CLI / Tauri / Electron ── JSON-RPC + WebSocket ──▶ Forge Core
                                                      ├─ sessions + agents (SQLite, persistent)
                                                      ├─ agent loop (model ⇄ tools)
                                                      ├─ workspace, shell, git, tests (jailed + permissioned)
                                                      └─ event bus (live stream + replay)
```

Core is authoritative; clients only render and request operations. Any client
(CLI, Tauri, Electron) can inspect the same live session. See
`ARCHITECTURE.md` for the full design.

## Prerequisites

- Node.js ≥ 22 (native TypeScript + SQLite, no build step for Core/CLI)
- npm ≥ 10
- Git (for `git_*` tools)
- A model provider: [OpenAI API key](https://platform.openai.com/api-keys)
  (or any OpenAI-compatible endpoint), **or** use the `mock` provider to
  exercise the plumbing without a key.

## Install

```bash
git clone <this-repo> && cd Forge
npm install
```

## Configure the provider

```bash
export OPENAI_API_KEY="sk-..."        # required for provider 'openai'
export OPENAI_BASE_URL="https://api.openai.com/v1"  # optional (OpenRouter, Ollama, vLLM…)
export FORGE_PROVIDER="openai"        # or 'mock' (deterministic, no key)
export FORGE_MODEL="gpt-4o-mini"
```

See `.env.example` and `forge.config.example.json` for all options
(`FORGE_PORT`, `FORGE_DATA_DIR`, `FORGE_TOKEN`, resource limits, …).

## Run Core

```bash
# standalone server (default http://127.0.0.1:8710)
node packages/core/src/serve.ts
# or
node packages/cli/src/main.ts serve --port 8710
```

## Run the CLI

```bash
CLI="node packages/cli/src/main.ts"
$CLI run "Fix the failing test in this repository" --workspace ./myrepo
$CLI session list
$CLI session resume <id>
$CLI status
$CLI agents --session <id>
$CLI events --session <id> --follow
```

`forge run` connects to a running Core (`FORGE_CORE_URL`) or spawns an
embedded one. `--yes` auto-approves approval gates (use with care).
To install the `forge` binary globally: `npm link -w @forge/cli`.

## Launch the desktop clients

Both shells connect to the same Core/protocol (start Core first, or point them
at `FORGE_CORE_URL`). They share one UI core: conversation, agent state, live
activity, changed files + diffs, terminal output, and approval prompts.

```bash
# Tauri frontend (dev) — needs Core on :8710
npm run dev -w @forge/tauri        # → http://localhost:1420
# Native Tauri window (needs the Rust toolchain + `cargo tauri` setup)
npm run tauri:dev -w @forge/tauri

# Electron renderer (dev)
npm run dev -w @forge/electron     # → http://localhost:1421
# Native Electron window (needs `npm install -w @forge/electron` incl. binary)
npm run dev:electron -w @forge/electron
```

## Run tests

```bash
npm test                              # everything (protocol + core + e2e)
npm run test:unit                     # fast unit tests
npm run test:integration              # tools, server, security, failures, perf
npm run test:e2e                      # full agent-repairs-fixture acceptance
npm run typecheck -ws                 # strict typecheck (all workspaces)
```

The E2E suite runs a real agent against `tests/fixtures/fixture-project`
(read → test → observe failure → edit → test passes → summary) with only the
LLM itself doubled; the OpenAI adapter is verified against a stub SSE server.

## Project layout

```text
packages/protocol   versioned protocol: IDs, errors, events, RPC schemas
packages/core       authoritative runtime (sessions, agents, tools, models…)
packages/client     typed RPC + WS client (Node + browser)
packages/cli        `forge` CLI
packages/web-ui     shared desktop UI
apps/tauri          Tauri shell + Vite frontend
apps/electron       Electron shell + Vite renderer
tests/              fixture repo + end-to-end acceptance
```

## Phase 1 scope

Implemented: persistent sessions, agent state machine, event bus + replay,
tool registry (filesystem, search, shell, git status/diff/log, tests/build),
one real provider (OpenAI-compatible) with streaming tool calls, bounded
context + `AGENTS.md`, Core-enforced permissions + approvals, cancellation,
CLI, Tauri + Electron shells.

Not yet: teams/swarms, subagent hierarchies, planners, remote workers, plugin
marketplace, model routing, full web app. Extension points exist; machinery
does not.
