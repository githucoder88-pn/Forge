# Forge Security

## Threat model (v0.1)

Forge is a **single-user local engineering runtime**. It executes
model-directed shell commands and edits files on your machine. The primary
threats are:

1. **Prompt injection → dangerous tool use.** A model (or code it reads) may
   attempt destructive commands. Mitigations: autonomy levels, risk
   classification, approval gates, command allow/deny lists, rooted
   workspace, secret redaction.
2. **Network exposure of the API.** The server binds loopback by default and
   uses a bearer token. Mitigations: loopback default, token auth, CORS
   same-origin.
3. **Secret leakage.** API keys in config/logs/prompts. Mitigations: keys
   visible to config ONLY via environment variables, redaction in context
   assembly and logs.
4. **Untrusted plugins.** Local plugins run in-process with full privilege.
   Mitigation: explicit trust boundary — load only plugins you control
   (see below). No remote plugin fetching exists.

Out of scope for v0.1: multi-user isolation, plugin sandboxing, supply-chain
signing of plugins, encrypted-at-rest store.

## Authentication

- Bearer token auto-generated at `~/.forge/token` (mode `0600`), sent as
  `Authorization: Bearer …` or `?token=…`.
- Requests from loopback bypass auth for local UX **unless**
  `FORGE_REQUIRE_AUTH=1` is set — set it on shared machines.
- `--host 0.0.0.0` binds are allowed but require the token for non-loopback
  peers; never expose Forge to the public internet without a reverse proxy
  with TLS + auth in front.

## Autonomy & approvals

| Level | Allows |
|---|---|
| `read-only` | inspect only (no writes, no shell) |
| `plan` | + planning artifacts |
| `supervised` | low-risk writes; medium/high-risk need approval |
| `autonomous` | + medium-risk without prompts; high-risk need approval |
| `unrestricted` | everything (explicit opt-in per session) |

- `rm -rf`, disk writes outside the workspace, network exfil patterns, and
  privilege escalation classify as **high-risk** and always require approval
  below `unrestricted`.
- In non-interactive mode (piped stdin / `--yes` absent), approvals are
  **denied by default** (fail-closed); `forge run` exits 2.
- Pending approvals are listed/approved via CLI (`forge approvals`) and the
  web console banner.

## Secrets

- Provider keys come from the environment (`OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`). Config files
  may reference `${ENV_VAR}` but must never contain raw keys.
- `secrets.ts` redacts known key patterns from assembled prompts, stored
  logs, and event payloads.

## Workspace confinement

All file tools resolve inside the session workspace root; `..` escapes are
rejected. Shell commands run with `cwd` = workspace root and do NOT inherit
`NODE_TEST_CONTEXT` or other harness variables that change child behavior.

## Plugin trust boundary

`forge.plugin.json` plugins are **arbitrary local code, fully trusted**:
they register tools/providers and can read the event bus. Only set
`--plugins` / `FORGE_PLUGINS` to directories you control. Never load plugins
from untrusted checkouts. Marketplace/sandboxed plugins are future work.

## Reporting

Found a vulnerability? Please open a GitHub issue with `[SECURITY]` in the
title or email the maintainers. Do not post exploit details publicly until a
fix is available.
