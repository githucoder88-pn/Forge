# Contributing to Forge

## Setup

```bash
git clone https://github.com/githucoder88-pn/Forge.git
cd Forge
npm install
npm run build
```

Requires Node.js ≥ 22.5 (uses `node:sqlite`, global `WebSocket`, `node:test`).

## The one rule

**Core is the single source of truth.** New behavior goes in
`@forge/core` with tests; the protocol, server, and clients expose it —
never reimplement it. Thin-client rule: if a feature works in the CLI but
not over the protocol, the protocol is incomplete, not the CLI clever.

## Workflow

1. Inspect before modifying — read the module + its tests first.
2. Vertical slices — wire Core → protocol → server → client in one PR.
3. Real implementations only. No mocks in production code. Test doubles must
   be flagged (`simulated: true`) and live in tests/demo paths only.
4. `./scripts/check.sh` must pass before pushing (build + all package tests).

## Commands

```bash
npm run build            # tsc across all workspaces
npm run test             # all workspace tests (node:test)
npm run typecheck        # tsc --noEmit everywhere
./scripts/check.sh       # build + typecheck + tests + web syntax check
forge demo               # end-to-end smoke (scripted models, real tools)
```

## Conventions

- TypeScript strict, `.js` extension imports (NodeNext), no default exports
  for modules with multiple symbols.
- Errors: `ForgeError(code, message, details?)` — codes in `errors.ts`.
  Never throw strings; never `process.exit` in libraries.
- Events: new event types go in `events.ts` with a versioned `type` string;
  emit at the state transition, not after the fact.
- Tools: JSON-Schema `inputSchema`, `minAutonomy`, cancellable handlers
  that respect `AbortSignal`.
- Tests: `node:test` + `node:assert/strict`, real temp dirs, no network
  beyond loopback probes. Name: `src/test/<module>.test.ts`.

## Pull requests

- Describe the vertical slice: Core change → protocol method → client
  surface → test evidence (paste gate output).
- Update `docs/` for user-visible changes; update `ARCHITECTURE.md` for
  structural decisions.
