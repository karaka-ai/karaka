# AGENTS.md

Every agent must read `/home/aman/.codex/skills/clarity/SKILL.md` before working in this repository.

Karaka is a Cordis foundation. The active runtime consists only of the nine packages under `vendor/`; application capabilities belong in future plugins rather than this foundation.

## Rules

- Read [docs/architecture.md](docs/architecture.md) before changing the package graph.
- Treat `vendor/*/src` as pinned upstream source. Record every source divergence in [vendor/README.md](vendor/README.md) and add a focused regression test.
- Keep package imports under `@karaka/*`; do not add compatibility aliases for earlier scopes.
- Register contributions through Cordis effects so plugin disposal reverses them.
- Keep infrastructure contracts independent of providers and consumers when adding future capabilities.
- Update English and Simplified Chinese documentation together.
- Do not edit, move, or delete `.agents/notes/archived/`; it is frozen pre-reset history.
- Run focused tests, then `pnpm run verify`, for repository-wide changes.

## Commands

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run docs:check
pnpm run verify
pnpm run release:pack
```
