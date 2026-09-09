# Forge Tauri shell

Thin, lightweight desktop client for Forge. It connects to a running Core
server (`forge serve`) and hosts the same web client served at `/app/`.

It implements **no** orchestration, routing, tools, or state — every
operation goes through the versioned Forge protocol.

## Prerequisites

- Rust stable toolchain
- Tauri CLI: `cargo install tauri-cli --version "^2"`
- A running Core server: `forge serve` (default `http://127.0.0.1:8719`)

## Run (development)

```bash
cd apps/forge-tauri
cargo tauri dev
```

The dev window loads the live web client from the Core server, so the
desktop UI is always identical to the web UI.

## Build

```bash
cd apps/forge-tauri
mkdir -p dist && cp ../forge-web/public/* dist/
cargo tauri build
```

Copying the static client into `dist/` bundles the exact same UI the
server serves; alternatively keep `devUrl`-style remote loading for a
server-paired install.

## Security notes

- The window only loads the configured Core origin (see `tauri.conf.json`
  content security policy).
- Remote servers require the server token; the web client prompts for it
  in Settings.
