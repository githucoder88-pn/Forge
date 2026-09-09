# AGENTS.md — project instructions for Forge agents

> Copy to your workspace root. Agents receive this every iteration.

## Commands

- Install: `npm ci`
- Test: `npm test` (must pass before finishing any task)
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`

## Conventions

- TypeScript strict; ESM imports with `.js` extensions.
- Co-locate tests as `*.test.ts` next to sources.
- Small, focused commits; never commit `node_modules/` or `.env`.

## Forbidden

- `rm -rf` outside the workspace; force-push; editing `main` directly.
- Adding dependencies without asking.
- Committing secrets — keys live in env vars only.

## Definition of done

`npm run build && npm test` green, no new lint errors, changes summarized.
