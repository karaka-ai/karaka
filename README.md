# Karaka

English | [中文](README.zh.md)

Karaka is a configurable, Cordis-based foundation for composing agentic SaaS runtimes. Stable capability seams define what an application can do, ordinary Cordis plugins implement those seams, and YAML or programmatic configuration selects the running product.

Karaka-provided and user-authored plugins use the same service contracts, dependency tracking, lifecycle effects, and isolation. The first application seam is Authentication: `@karaka/authentication` owns the tenant router and provider-neutral contract. Its `authentication-jwks` plugin verifies tenant tokens, while `authentication-host` establishes an isolated identity asserted by a trusted embedding host—the simplest local-development path.

## Packages

The composition kernel publishes nine packages under `@karaka`: `cordis`, `cosmokit`, `schemastery`, and the `loader`, `include`, `group`, `timer`, `hmr`, and `logger-console` Cordis plugins. They are pinned forks with local changes documented in [vendor/README.md](vendor/README.md).

Application packages live outside `vendor/`. The first is [`@karaka/authentication`](packages/authentication/README.md); its `authentication-jwks` and `authentication-host` subpaths are independently selectable from Loader configuration.

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
