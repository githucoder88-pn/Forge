# Protocol reference (`forge/1`)

JSON-RPC 2.0 over HTTP (`POST /rpc`), with live events over WebSocket
(`GET /events/ws`) or SSE (`GET /events`). Every envelope carries
`protocol: 'forge/1'`; mismatches fail with `PROTOCOL_MISMATCH`.

```bash
curl -s localhost:8719/rpc -H 'content-type: application/json' -d '
{"jsonrpc":"2.0","id":1,"protocol":"forge/1",
 "method":"session.create","params":{"goal":"Ship it"}}'
```

## Method namespaces (60+ methods)

| Namespace | Examples |
|---|---|
| `session.*` | `create/resume/list/info/setAutonomy/summary` |
| `agent.*` | `create/start/cancel/retry/tree/report` |
| `task.*` | `create/list/topo/retry/cancel/run` |
| `team.*` | `create/roster/handoff/standup/blockers` |
| `message.*` | `send/read/channels/threads` |
| `tool.*` | `list/invoke` |
| `model.*` | `list/status/complete` |
| `memory.*` | `set/get/search/delete` |
| `checkpoint.*` | `create/list/diff/restore` |
| `events.*` | `subscribe/replay` |
| `runtime.*` | `run/plan/enhance/status` |
| `workspace.*` | `read/write/list/changes` |
| `progress.*` | `get` |
| `approvals.*` | `list/approve/deny` |
| `validation.*` | `run` |
| `context.*` | `preview` |

Long operations (`runtime.run`, `task.run`, `agent.start`, `validation.run`)
detach immediately with `{accepted:true, id}` and stream progress events.

## Live streams

- WebSocket: connect `/events/ws?session=<id>&sinceSeq=<n>` → JSON frames
  `{seq,type,data,ts}` with heartbeat `ping`s.
- SSE: `GET /events?session=<id>&sinceSeq=<n>` → `event:/data:` stream.
- `events.replay --since <seq>` re-fetches history over plain RPC.

## Errors

Standard JSON-RPC errors plus Forge codes (`MODEL_ALL_FAILED`,
`APPROVAL_DENIED`, `TOOL_INPUT_ERROR`, `PROTOCOL_MISMATCH`,
`SESSION_NOT_FOUND`, …) in `error.data.code` with HTTP mapping
(4xx client / 5xx server).
