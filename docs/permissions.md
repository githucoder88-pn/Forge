# Permissions & approvals

## Autonomy levels

`read-only < plan < supervised < autonomous < unrestricted`

Set per session (`forge run --autonomy …`, `session.setAutonomy`); agents
and subagents inherit a ceiling that can only narrow.

## Risk classification

Shell commands and sensitive tools are classified:

- **low** — reads, listings, `git status`, test runs
- **medium** — file writes, installs, `git commit`, network fetch
- **high** — recursive deletes, force push, `sudo`, privilege changes,
  writes outside workspace, credential access, mass network egress

Below `unrestricted`, high-risk actions ALWAYS require approval;
medium-risk requires approval below `autonomous`.

## Approval flow

1. Executor raises `approval.requested` (CLI prints a prompt; web shows a
   banner; `forge approvals` lists pending).
2. Human approves/denies (CLI interactive, `forge approve <id>`, or web).
3. Tool proceeds or fails with `APPROVAL_DENIED`.

**Fail-closed:** non-interactive runs (piped stdin, CI, `--non-interactive`)
deny all approvals; `forge run` exits 2 with the pending approval listed.
Timeouts deny by default (configurable).

## Allow / deny lists

```jsonc
{ "permissions": {
  "allow": ["npm test", "git *"],
  "deny": ["rm -rf *", "curl * | sh"]
} }
```

Deny wins over allow; both are glob-matched against the normalized command.
Changes apply to new invocations immediately.
