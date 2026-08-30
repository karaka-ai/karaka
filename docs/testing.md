# Testing

English | [中文](testing.zh.md)

Kernel tests live under `tests/`. Application-package tests live with their package under `packages/*/tests/`. They cover Cordis lifecycle ownership, service replacement, Loader/Include configuration transactions, patch semantics, exact-path HMR, Authentication provider disposal, OAuth token acquisition and JWT verification, request-scoped trusted-user isolation, and authenticated SDK-to-Transport composition.

Use `pnpm run test` for behavior. Use `pnpm run build && pnpm run example` for the real built entry path. `pnpm run release:pack` creates each publish payload, installs every tarball into a temporary NodeNext consumer, type-checks root and subpath imports, and runs a lifecycle smoke test. A source change under `vendor/` must add or update the regression test that proves the local divergence.
