# Configuration

Forge merges settings from four layers (highest precedence first):

1. **Project** — `.forge/forge.json` (or `forge.yaml`) in the workspace root
2. **User** — `~/.forge/config.json`
3. **Environment** — `FORGE_*` variables
4. **Defaults** — built in

```jsonc
// .forge/forge.json
{
  "providers": {
    "openai": { "apiKeyEnv": "OPENAI_API_KEY", "models": ["gpt-4o", "gpt-4o-mini"] },
    "ollama": { "baseUrl": "http://127.0.0.1:11434" }
  },
  "routing": {
    "default": "openai:gpt-4o-mini",
    "fallbacks": ["ollama:llama3.1"],
    "maxRetries": 3
  },
  "autonomy": "supervised",
  "approvals": { "requireFor": ["high-risk"] },
  "context": { "maxTokens": 120000, "redactSecrets": true },
  "validation": { "preset": "node-ts" },
  "store": { "path": "~/.forge/store.db" }
}
```

Key points:

- **Layered merge is deep for objects.** `routing.fallbacks` in project
  config replaces (not appends to) the user-level list.
- **`${ENV_VAR}` interpolation** is supported in string values. API keys
  must ALWAYS come from the environment — never raw keys in files.
- `forge serve` watches config files and reloads without restart
  (in-flight runs keep their snapshot).
- Unknown keys are rejected with `CONFIG_ERROR` (fail fast on typos).
- Per-session overrides: `forge run --autonomy autonomous --model …`.

### Environment variables

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` | provider auth |
| `FORGE_HOME` | home dir override (token, store, config) |
| `FORGE_REQUIRE_AUTH`=`1` | require token even on loopback |
| `FORGE_PLUGINS` | local plugins directory |
| `FORGE_PORT` / `FORGE_HOST` | server bind |
