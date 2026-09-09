# Troubleshooting

## `forge model status` shows `offline (fetch failed)`

The provider was probed and didn't answer. For local runtimes, start them
first (`ollama serve`, or open LM Studio with the server enabled). For
cloud providers, check the key env var and network access. `offline` is
measured truth, not a bug.

## `forge run` exits 2 immediately

An approval was requested and denied fail-closed (non-interactive shell,
piped stdin, or timeout). Re-run interactively, pre-approve with broader
autonomy (`--autonomy autonomous`), or scope the goal to avoid high-risk
steps. `forge approvals` shows what was asked.

## `Approval denied` for `rm` / force-push / sudo

High-risk by design. Below `unrestricted`, these always need a human.
If the step is genuinely safe, approve it explicitly — don't widen
autonomy reflexively.

## `SESSION_NOT_FOUND` / empty lists

You're pointing at a different home (`FORGE_HOME`) or store path than the
run used. `forge status --session <id>` against the same `--project` and
`FORGE_HOME` as the server fixes it.

## `PROTOCOL_MISMATCH`

Client and server speak different `forge/1` versions. Rebuild + restart
both from the same checkout.

## Demo says `[sim] tests failed`

The demo runs REAL `node --test` in a scaffolded project — a failure means
the scaffold or toolchain regressed (we assert the green path in
`demo.test.ts`). Check `node --version` (≥ 22.5) and report it as a bug.

## Web console shows "disconnected"

The WS stream dropped; the console resumes with `sinceSeq` automatically.
If it persists, check the server log and that nothing else bound the port
(`forge serve --port 8720`).

## `EADDRINUSE` on serve

Another `forge serve` (or a crashed one) holds the port. Find it
(`lsof -i :8719`) or pick another port.

## Reset everything (local dev)

```bash
rm -rf "$FORGE_HOME"   # default ~/.forge — token, store, config gone
```
