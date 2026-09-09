# Forge

**Open-source AI engineering platform: autonomous coding agents, multi-agent
teams, model routing, and real-time orchestration — with one authoritative
runtime (Core) and thin clients.**

Forge is an executable engineering runtime, not a chatbot skin. Every visible
agent maps to a real runtime object, every event to a real state transition,
every file change to a real tool execution. If the runtime doesn't know
something, the UI doesn't invent it.

## Quickstart

Requirements: Node.js ≥ 22.5.

```bash
git clone https://github.com/githucoder88-pn/Forge.git
cd Forge
npm install
npm run build

# 1. Run the self-contained demo (scripted models, REAL tools, temp workspace)
node packages/forge-cli/bin/forge.js demo
# or, once linked:  forge demo

# 2. Start the server (API + live events + web client)
forge serve --project /path/to/your/repo
# → http://127.0.0.1:8719/app/

# 3. Run an agent on a goal (needs a configured provider — see below)
forge run "Fix the failing checkout tests" --plan
```

Configure a model provider with an API key (never stored in config files):

```bash
export OPENAI_API_KEY=...     # or ANTHROPIC_API_KEY / GOOGLE_API_KEY / OPENROUTER_API_KEY
forge run "Refactor the auth module" --team eng:backend,frontend,qa
```

…or point Forge at a local runtime (no key needed):

```bash
# Ollama (http://127.0.0.1:11434) and LM Studio (http://127.0.0.1:1234/v1)
# are probed automatically. Start one, then:
forge model status
```

## What Forge does

- **Coding agents** with a real model→tool→observe loop: inspect, plan,
  edit, test, review, repair — resumable and observable.
- **Teams & subagents** with roles, task queues, real message passing,
  handoffs, and aggregated blockers.
- **Task graphs** (DAG scheduler): dependencies, priorities, parallel
  execution, retries, failure propagation, deadlock detection.
- **Model routing**: capability-aware selection, retries with backoff,
  fallback chains, health tracking, circuit breaking, token accounting.
- **Tools**: filesystem, shell (streaming/cancellable), git, tests/build/
  lint presets, HTTP, environment inspection — all permission-gated.
- **Permissions**: autonomy levels (`read-only` → `unrestricted`), risk
  classification of commands, human approval gates.
- **State**: sessions, scoped memory, checkpoints + rollback, event history
  — everything persists in SQLite and survives restarts.
- **Clients**: CLI, web console, Electron and Tauri shells — all speaking
  the same versioned protocol to the same Core.

## Repository layout

```text
forge/
├── packages/
│   ├── forge-core/        # THE runtime: agents, tasks, teams, models, tools…
│   ├── forge-protocol/    # Versioned JSON-RPC protocol (forge/1)
│   ├── forge-server/      # HTTP API + WebSocket/SSE events + static clients
│   ├── forge-cli/         # `forge` command
│   └── protocol-client/   # Typed TS client (CLI/Web/Electron/Tauri)
├── apps/
│   ├── forge-web/         # Static web console (served by the server)
│   ├── forge-electron/    # Thin Electron shell (hosts the web client)
│   └── forge-tauri/       # Thin Tauri shell (hosts the web client)
├── plugins/               # Local plugins directory (see docs/plugins.md)
├── examples/              # Config, AGENTS.md, plugin examples
├── docs/                  # Guides per subsystem
├── scripts/               # Dev/test helpers
├── ARCHITECTURE.md        # System design + key decisions
├── CONTRIBUTING.md        # Development workflow
└── SECURITY.md            # Threat model + security boundary
```

## Commands (CLI)

```bash
forge serve                         # Core server: API + events + web UI
forge run "<goal>" [--plan] [--team eng:backend,qa] [--enhance]
forge plan "<goal>"                   # task graph only, no execution
forge demo                            # end-to-end demo (SIMULATED models)
forge status | agents | tasks | teams | message | model | checkpoint | approvals
forge watch --session <id>            # live event stream
forge logs --session <id>             # persisted event history
forge --help
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — design, decisions, data flow
- [docs/configuration.md](docs/configuration.md) — config layers & options
- [docs/providers.md](docs/providers.md) — models, routing, failover
- [docs/agents.md](docs/agents.md) — agent lifecycle & the coding loop
- [docs/teams-tasks.md](docs/teams-tasks.md) — teams, messaging, task graphs
- [docs/tools.md](docs/tools.md) — tool runtime & built-ins
- [docs/permissions.md](docs/permissions.md) — autonomy, approvals, secrets
- [docs/memory-context.md](docs/memory-context.md) — memory scopes, context engine
- [docs/protocol.md](docs/protocol.md) — wire protocol reference
- [docs/cli.md](docs/cli.md) — CLI reference
- [docs/web.md](docs/web.md) — web console guide
- [docs/plugins.md](docs/plugins.md) — plugin API + trust boundary
- [docs/troubleshooting.md](docs/troubleshooting.md) — common issues
- [SECURITY.md](SECURITY.md) — threat model, auth, reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) — build, test, contribute

## Truth contract

- No mock orchestration in production paths. Simulated output (demo mode,
  test doubles, explicit echo fallback) is always flagged `simulated` and
  rendered as **SIMULATED**.
- Provider health is measured at boot and on every call — never assumed.
- Progress comes from agent reports + measured tool/file activity.
- The UI renders Core state only.

## License

MIT — see [LICENSE](LICENSE).
