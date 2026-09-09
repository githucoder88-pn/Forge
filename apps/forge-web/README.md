# forge-web

Zero-dependency static console for Forge Core. Served by `forge serve` at
`/app/` — there is no separate dev server or build step.

- `public/index.html` — shell, views mount here
- `public/api.js` — JSON-RPC + WebSocket client (`forge/1`)
- `public/views.js` — the 12 views
- `public/app.js` — boot, patching, palette, approvals banner
- `public/styles.css` — theme

Syntax gate: `node --check` on each JS file (see `scripts/check.sh`).
User guide: [docs/web.md](../../docs/web.md).
