# Forge Security (Phase 1)

## Threat model

Forge executes AI-directed file and shell operations on the developer's own
machine. Phase 1 assumes a **single-user local machine**: the operator runs
Core and the clients, and the model is semi-trusted (prompt injection and
mistakes are expected; malice from the local operator is out of scope).

## Boundaries (enforced in Core, never in clients)

- **Workspace jail**: every filesystem path is normalized and confined to the
  session root. `..` escapes, absolute paths outside the root, NUL bytes, and
  `~` expansion are rejected with `WorkspaceViolation` before any I/O.
- **Tool permissions**: modes (`read-only`, `workspace-write`,
  `full-workspace`) + approval policies (`always`, `risky-only`, `never`).
  Destructive tools require approval; unknown shell binaries require approval
  (or are denied when approvals are off).
- **Shell vetting**: every segment of chained commands (`&&`, `;`, `|`,
  `$()`, backticks) is vetted. Always-denied binaries include `rm`, `curl`,
  `wget`, `ssh`, `nc`, and privilege wrappers (`sudo`, `su`, `doas`) — in
  *all* modes. Auto-detected test/build commands are vetted at execution.
- **Git**: only read-only commands exist (`status`, `diff`, `log`). No
  reset/clean/push surface in Phase 1.
- **Approvals**: gates suspend tool execution until `resolve_approval`
  (deny-by-default after 10 minutes). `--yes`/`autoApprove` bypasses gates —
  use only in trusted, disposable environments.
- **Secrets**: API keys come from env/config only. Logs pass through
  `redactSecrets` (`sk-*`, `api_key`, bearer tokens). Provider errors never
  include credentials.

## Local transport

- Core binds loopback (`127.0.0.1`) by default. Remote exposure is **not**
  supported in Phase 1: do not bind `0.0.0.0` or put Core behind a proxy
  without adding authentication first.
- Optional shared token: set `FORGE_TOKEN` to require
  `Authorization: Bearer …` on HTTP and WebSocket (401/4401 otherwise).
- Desktop renderers run with a restrictive CSP, Electron with
  `nodeIntegration: false` + `contextIsolation` + `sandbox`, and a
  versions-only preload bridge.

## What to do on a suspected vulnerability

Open a **private** report with: affected version/commit, reproduction steps,
expected vs actual containment, and logs (redact keys). Do not file public
issues with exploit details until a fix is available.

## Known Phase-1 limitations

- No multi-user authN/authZ, no audit log beyond the event store.
- `full-workspace` + `--yes` is equivalent to running model-chosen commands
  as your user: only use it on machines/sandboxes you can afford to lose.
- Supply-chain: dependencies are minimal (`ws`, `zod`, `vite`, `electron`,
  `typescript`) — review `package-lock.json` diffs on upgrade.
