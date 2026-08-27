# Development

English | [中文](development.zh.md)

Run `pnpm install` once, then use `pnpm run typecheck`, `pnpm run test`, and `pnpm run build` while developing. `pnpm run verify` checks the complete active package graph. `pnpm run clean` removes build and package artifacts.

The source plane resolves `@karaka/*` imports through `tsconfig.base.json`. The artifact plane uses package exports from built `lib/`. The foundation example and package tarball checks exercise the artifact plane, including application-package subpath exports.

Package publication is manual. Build and verify first, inspect tarballs from `pnpm run release:pack`, then invoke `pnpm run release:publish` only with explicit release authority.
