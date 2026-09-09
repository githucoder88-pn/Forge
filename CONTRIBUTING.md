# Contributing to Forge

## Setup

```bash
npm install
npm test            # must be green before you push
npm run typecheck -ws
```

Node ≥ 22 required. Core/CLI run from TypeScript sources directly (no build).

## Working style

- Vertical slices over scaffolding: every change should compile, run, and be
  tested. No placeholder interfaces, no fake tool calls, no hardcoded success.
- Root-cause fixes. If a test fails, understand why before touching code.
- Smallest complete version of a feature; extend later.

## Code rules

- **Erasable TypeScript only** (`erasableSyntaxOnly`): no parameter
  properties, no enums, no namespaces. The codebase runs on Node's type
  stripping and must also satisfy `tsc --noEmit` strict.
- **IDs**: domain identity is `packages/protocol/src/ids.ts` (UUIDv7 +
  prefix, CSPRNG). Never use `Math.random()` for IDs. Use branded types
  (`AgentId`, `SessionId`, …) so mixing is a compile error.
- **Core owns everything**: sessions, agents, tools, models, events,
  permissions, persistence. Clients (CLI/Tauri/Electron) render and request —
  never duplicate runtime logic. New behavior goes in `packages/core` behind
  the versioned protocol.
- **Errors are typed**: throw `ForgeError` with the right code; never leak
  raw internals (stacks, keys, absolute host paths outside the workspace) as
  the API contract. Redact secrets in logs (`redactSecrets`).
- **Tools**: register in the `ToolRegistry` with a JSON Schema for the model
  *and* a zod schema for Core-side validation. Every tool must honor
  `AbortSignal`, timeouts, and output caps; mutations emit `file.*` events.
- **Permissions first**: new side effects need a risk classification in
  `permissions.ts` and tests proving the default policy contains them.
- **Events**: state changes emit typed events with enough payload to rebuild
  client state. Ordering key is `seq`, never wall-clock time.

## Adding a tool

1. Define it in `fsTools.ts`/`execTools.ts` (or a new `*Tools.ts` + register
   in `app.ts`): `name`, `description`, `parameters` (model JSON Schema),
   `input` (zod), `execute(ctx)`.
2. Classify risk in `permissions.ts` (`toolRisk` + shell vetting if it execs).
3. Add unit/integration tests (success, failure-as-result, permission denial,
   cancellation, output caps).
4. Document it in `ARCHITECTURE.md` §10 and the README scope list.

## Adding a provider

1. Implement `ModelProvider` in `models.ts` (or a new module): `complete()`
   must stream, accumulate tool calls, propagate `AbortSignal`, and map
   failures to `ForgeError` codes.
2. Credentials from env/config only — never hardcoded, never logged.
3. Add an adapter test against a local stub HTTP server (see
   `tests/integration/provider.test.ts`), including SSE parsing, tool-call
   accumulation, error mapping, and cancellation.

## Tests

- `node --test` over colocated `*.test.ts`. Unit (fast, pure) →
  integration (real tools/server/store) → E2E (real agent loop on the
  fixture; only the LLM is doubled).
- New features need tests at the right level; bug fixes need a regression
  test that fails before the fix.
- Never weaken a security test to make it pass — fix the code.

## Commits & branches

- Work on feature branches; keep `main` green.
- Commit messages: imperative scope + what/why (`core: kill process groups on
  cancel to prevent orphaned shells`).
