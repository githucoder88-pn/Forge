# Tool runtime

Tools (`tools.ts`) are JSON-Schema-validated functions with autonomy floors,
executed by the tool executor with timeouts, cancellation, and redaction.

## Built-ins

| Tool | Purpose | Min autonomy |
|---|---|---|
| `read_file` / `write_file` / `edit_file` / `delete_file` | rooted file ops | read-only / supervised |
| `list_dir` / `search` / `glob` | navigation, ripgrep-style search | read-only |
| `run_shell` | streaming, cancellable shell | supervised+ (risk-gated) |
| `run_tests` / `run_build` / `run_lint` | validation presets | supervised |
| `git_status` / `git_diff` / `git_commit` | VCS inspection + commits | supervised/autonomous |
| `http_fetch` | GET with size caps + redirect limits | supervised |
| `env_info` | runtime/platform inspection | read-only |

## Execution semantics

- Inputs validated against `inputSchema` BEFORE permission checks
  (fail fast on malformed calls: `TOOL_INPUT_ERROR`).
- Permission check: session autonomy ≥ tool floor AND command risk ≤
  allowed (see [permissions](permissions.md)); denials request approval.
- Shell tools stream `stdout/stderr` chunks as events, enforce line caps,
  run with `cwd` = workspace, and strip harness variables
  (`NODE_TEST_CONTEXT`) so children behave identically everywhere.
- Every invocation is timed, logged, and persisted (`tool.invoke` RPC, or
  direct executor use); results are truncated safely for context.

## Custom tools (plugins)

Plugins register namespaced tools via `ctx.registerTool(def, handler)` —
see [plugins](plugins.md) and `examples/custom-tool-plugin/`.
