# Testing

English | [中文](testing.zh.md)

Foundation tests live under `tests/`. They cover Cordis lifecycle ownership, service replacement, Loader/Include configuration transactions, patch semantics, exact-path HMR, and the built example.

Use `pnpm run test` for behavior. Use `pnpm run build && pnpm run example` for the real built entry path. `pnpm run release:pack` creates each publish payload, installs all nine tarballs into a temporary NodeNext consumer, type-checks its imports, and runs a lifecycle smoke test. A source change under `vendor/` must add or update the regression test that proves the local divergence.
