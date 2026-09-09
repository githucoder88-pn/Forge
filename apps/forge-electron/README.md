# Forge Electron shell

Thin desktop client for Forge. It connects to a running Core server
(`forge serve`) and hosts the same web client served at `/app/`.

It implements **no** orchestration, routing, tools, or state — every
operation goes through the versioned Forge protocol.

## Run

```bash
# 1. Start Core (any terminal)
forge serve

# 2. Install the Electron runtime (needs network access to Electron releases)
cd apps/forge-electron
npm install --save-dev electron

# 3. Launch
FORGE_URL=http://127.0.0.1:8719 npx electron .
```

## Security notes

- The window runs with `contextIsolation`, no `nodeIntegration`, and
  `sandbox: true`.
- Remote servers require the server token; the web client prompts for it
  in Settings.
