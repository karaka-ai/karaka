# Karaka

English | [中文](README.zh.md)

Karaka is a small, publishable Cordis foundation for applications whose infrastructure varies by deployment. It provides plugin composition, services, lifecycle effects, configuration loading, grouping, timers, hot reload, and console logging. It does not yet provide storage, identity, model, logging-vendor, secrets, session, agent, tool, or user-interface capabilities.

Applications should depend on conceptual services and install providers separately. A later storage consumer, for example, can depend on `ctx.storage` while an application chooses an S3, GCS, Azure Blob, or private implementation through configuration.

## Foundation packages

The repository publishes nine packages under `@karaka`: `cordis`, `cosmokit`, `schemastery`, and the `loader`, `include`, `group`, `timer`, `hmr`, and `logger-console` Cordis plugins. They are pinned forks with local changes documented in [vendor/README.md](vendor/README.md).

## Start

```sh
pnpm install
pnpm run build
pnpm run example
pnpm run verify
```

The [foundation example](examples/foundation/README.md) composes a service definition, two providers, and one consumer through a real Loader/Include tree. The [Cordis primer](docs/cordis-primer.md), [tutorial](docs/cordis-tutorial/index.md), and [architecture reference](docs/architecture.md) explain the framework.

Manual package verification and publication are available through `pnpm run release:pack` and `pnpm run release:publish`. This repository intentionally has no CI configuration during the foundation phase.

Historical DeepSeek Harness documentation and decision records live under [`legacy/deepseek-harness`](legacy/deepseek-harness/README.md). Git history owns removed product source.
