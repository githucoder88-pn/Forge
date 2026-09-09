# Plugins (API v1)

Plugins extend Core with tools, providers, and event hooks — no Core fork
needed. See `examples/custom-tool-plugin/` for a working plugin.

## Layout

```text
my-plugin/
├── forge.plugin.json      # manifest
└── index.mjs              # entry (ESM, Node ≥ 22)
```

```jsonc
// forge.plugin.json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "api": "forge-plugin/1",
  "entry": "./index.mjs",
  "description": "Shouts text, dramatically."
}
```

```js
// index.mjs
export async function activate(ctx) {
  ctx.registerTool(
    { name: 'shout', description: 'Uppercase text', minAutonomy: 'read-only',
      inputSchema: { type: 'object', required: ['text'],
        properties: { text: { type: 'string' } } } },
    async (input) => ({ shouted: String(input.text).toUpperCase() }),
  );
}
```

## Plugin context (`ctx`)

| Member | Purpose |
|---|---|
| `apiVersion` / `pluginName` | host handshake info |
| `tools` / `router` / `bus` | Core registries (advanced use) |
| `projectDir` | workspace root |
| `registerTool(def, handler)` | add a tool (auto-namespaced `name.tool`) |
| `registerProvider(provider)` | add a model provider |
| `log(message)` | emit a namespaced warning event |

## Loading

```bash
forge serve --plugins ./my-plugins
FORGE_PLUGINS=./my-plugins forge run "…"
```

Every subdirectory with a `forge.plugin.json` is loaded at boot; API
mismatches, bad manifests, and activation errors fail startup loudly
(`CONFIG_ERROR` listing each problem).

## Trust boundary (read this)

Local plugins run **in-process with full Core privilege**. They can read
the event bus, register tools that run shell commands, and add providers
that see your prompts. **Only load plugins from directories you control.**
Remote fetching, signing, and sandboxing are explicitly future work —
see [SECURITY.md](../SECURITY.md).
