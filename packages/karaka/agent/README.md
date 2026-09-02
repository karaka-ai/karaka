---
description: "Self-contained Karaka Agent runtime with bundled Cordis plugins, persistent sessions, authenticated application ingress, and project-owned extension loading."
kind: "package-library"
---

# @karaka/agent

English | [中文](README.zh.md)

## Summary

`@karaka/agent` is the complete Karaka Agent server runtime. Its executable bundles the Karaka-maintained Agent, Session, LLM, tool, persistence, preset, authentication, and HTTP transport implementations into one published package; an installed runtime does not resolve `@deepseek-ai/dsh-*` packages. A server project can still compose an Agent from bundled `@karaka/agent/*` aliases, relative plugin files in the project, and optional npm plugin packages installed by that project. `@karaka/cli` is the normal launcher, while `@karaka/agent/bin` is the stable process entry point it delegates to.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Install this package in a server project when that project must run Karaka. Prefer `karaka start` for normal operation; use the executable directly when another process supervisor already owns launch and shutdown. Application backends use `@karaka/sdk` instead and do not import this runtime.

### Entry point

```sh
KARAKA_HOME="$PWD/.karaka" npx karaka-agent --config "$PWD/karaka.cordis.yml"
```

`--config` must name an absolute deployment patch when the executable is invoked programmatically. A successful launch keeps the server in the foreground until `SIGINT` or `SIGTERM`; invalid arguments, a missing `KARAKA_HOME`, unreadable configuration, unresolved plugins, and failed plugin activation terminate with a diagnostic.

### Extend an Agent

An `agent.cordis.yml` row may name an embedded alias such as `@karaka/agent/persona` or `@karaka/agent/agent-tool-presentation`. Each embedded alias is also a Node subpath with the same named and default exports as its source module. Service Definition modules used by replacement providers have matching flat subpaths even when they are not Loader plugins; for example, a local storage provider can import `StorageBackend` without installing a DSH package:

```ts
import type { StorageBackend } from '@karaka/agent/storage'
```

An Agent project keeps application-specific plugins in its root `plugins/` directory. A deployment row can load one directly:

```yaml
- id: customer-storage
  name: ./plugins/customer-storage.js
```

Relative names resolve beside the composition file, so an Agent Preset uses `../../plugins/customer-tools.js` for a shared root plugin. A reusable plugin may instead be an installed package such as `@acme/customer-tools`. Both forms import public contracts from `@karaka/agent/*`; neither form depends on the private DSH build inputs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The executable loads the bundled base composition, applies Karaka's server patch, then applies the deployment patch named by `--config`. The plugin registry maps every shipped composition name to a statically imported implementation before the Cordis Loader mounts any row. Exact registry aliases take precedence over Node package resolution. Relative plugin files retain the composition directory as their base, while bare external packages use the server project's configuration URL as their Node resolution base.

The build emits one runtime chunk set shared by `lib/bin.js`, the Loader registry, and the entries under `lib/public/`, so services retain one JavaScript identity. Public declaration facades share one private declaration tree whose cross-package references are relative and contain no DSH package names. SQLite migrations and worker resources are shipped beside the executable because those implementations locate their assets through `import.meta.url`.

| File | Role |
|---|---|
| [`src/bin.ts`](src/bin.ts) | Process arguments, Karaka home validation, and launch delegation |
| [`src/launch.ts`](src/launch.ts) | Patch composition, project resolution base, boot, signals, and disposal |
| [`src/plugins.ts`](src/plugins.ts) | Exact `@karaka/agent/*` aliases for bundled runtime plugins |
| [`base.cordis.patch.yml`](base.cordis.patch.yml) | Bundled Agent runtime composition |
| [`cordis.patch.yml`](cordis.patch.yml) | Karaka authentication and application transport additions |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@karaka/cli`](../cli/README.md) — creates a server project and launches this executable.
- [`@karaka/sdk`](../sdk/README.md) — connects an application backend to a running Karaka server.
- [Cordis primer](../../../docs/cordis-primer.md) — explains composition rows, Loader resolution, services, and isolation.
- [Architecture](../../../docs/architecture.md) — describes the Agent, Session, capability, and application layers bundled here.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the model, prompt, tool, skill, and policy plugins selected by each Agent Preset.

#### KV Cache effect

The runtime adds no fixed model text itself; changing an Agent composition can change that Agent's system-prompt or tool-schema prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One Node process per launch** — replica count, TLS termination, and load balancing remain deployment concerns.
- **Local coding tools are disabled by default** — an Agent needs an explicit trusted plugin composition to gain filesystem or subprocess access.
- **Local TypeScript compilation is project-owned** — the runtime loads relative JavaScript files; a project that authors plugins in TypeScript must compile them before launch.

<a id="dev-note"></a>
### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>

None.

</details>
