# Agent Note: Karaka ships one self-contained Agent runtime package

Status: implemented

English | [中文](2026-09-02-karaka-agent-runtime-package.zh.md)

## Problem

Karaka needs the Cordis agent architecture, Agent Presets, model adapters, tools, durable Sessions, application authentication, and HTTP transport developed in this repository. Requiring a deployment to install and version the implementation as many `@deepseek-ai/dsh-*` packages makes DSH part of Karaka's public product identity and turns an internal module graph into a user-managed release graph.

The application backend and the Agent process have different lifecycles. Backend code needs a client and application-tool host, while the Agent process needs the complete runtime and a small launcher. Application-specific Cordis plugins must remain local to the server repository when independent publication has no value.

## Decision

Karaka publishes three packages. `@karaka/sdk` is the backend client and application MCP tool host. `@karaka/agent` is the complete persistent Agent server. `@karaka/cli` creates a project and launches the same-version Agent executable. Karaka publishes no separate harness, server, authentication, transport, or MCP bridge package.

The repository retains focused internal workspaces for development and tests. The `@karaka/agent` build statically includes the production DSH and Karaka modules it uses; those workspace packages are build-time inputs, not consumer runtime dependencies. Ordinary third-party libraries remain package dependencies when embedding them would break native installation, singleton identity, or upstream asset loading.

Agent owns the process entry, base Cordis composition, Karaka overlay, runtime assets, and an embedded plugin registry. Public configuration names use `@karaka/agent/*`. The Loader resolves those exact names from the embedded registry, resolves relative names from the file that declares them, and resolves other bare names from the Agent project. An application-specific plugin can therefore live under the server repository and load through `./` or `../`; a reusable plugin may remain an ordinary installed dependency.

Every embedded plugin name is also a public Node subpath with its original named and default exports. Contract-only Service Definition modules receive the same flat DSH-derived names without becoming Loader plugins. The Agent build emits the Loader and public entries through one shared runtime graph; public declaration facades share a private declaration tree with relative cross-package references, load their package-owned declaration augmentations, and contain no DSH package names. Agent projects depend directly on `@karaka/agent`, so local `plugins/*.js` files and reusable packages compile against the same service identities that the Loader mounts.

One agent definition remains one Agent Preset directory. `preset.yml` owns discovery metadata and `agent.cordis.yml` owns behavioral plugin composition. Each chat creates or resumes a distinct Agent and durable Session in that preset's standing generation. A changed composition starts another generation without replacing the instances used by joined chats.

Every application chat Session retains one atomic `{ applicationId, tenantId, userId }` owner in its durable header. The SDK sends authenticated chat requests and exposes explicitly registered backend callbacks as authenticated Streamable HTTP MCP tools. Authentication, HTTP/SSE ingress, and the application MCP client are internal Agent modules, but remain replaceable Cordis services and plugins.

`karaka start` resolves `@karaka/agent/bin`, gives it an absolute deployment patch, and supplies a private project-local Karaka home. Agent owns boot and graceful process teardown. Neither CLI nor SDK resolves or launches the `dsh` package, and no programmatic Agent boot API is part of the public contract.

## Alternatives considered

**Publish every DSH and Karaka workspace package.** This preserves npm package boundaries but makes application operators install and coordinate an internal implementation graph and exposes DeepSeek Harness naming as Karaka's runtime contract.

**Keep `@karaka/harness` as a thin DSH profile.** This minimizes build work but requires the DSH launcher and all modified plugin packages at deployment time, which leaves Karaka as configuration over another installed product.

**Put the complete runtime in `@karaka/cli`.** This makes a command package own the server implementation and prevents Agent extensions from depending on a stable runtime package without depending on CLI concerns.

**Embed Agent inside every application backend.** This couples request workers to model-turn lifetime, duplicates the runtime across services, and prevents one persistent Agent deployment from serving several backends.

**Define a Karaka-specific agent schema and rewrite the loop.** This would duplicate ReactLoopAgent, scoped registries, Session durability, Agent Presets, and Cordis disposal. Karaka changes the distribution and public module names while retaining those implementations and extension points.

**Import business functions into the Agent process.** This makes the Agent deployment carry application code and credentials. Authenticated MCP keeps the application as execution owner and lets tool discovery remain dynamic.

**Reuse the local SDK JSON-RPC lifecycle.** That protocol owns a child process and local byte streams. Karaka needs a caller-independent persistent server, durable application ownership, and reconnectable HTTP streaming.

## Consequences

A Karaka deployment installs one public runtime identity and can add private plugins without publishing them. Adding a supported DSH module to the embedded Loader registry also adds its matching public subpath; contract-only entries stay an explicit audited list. The embedded build must keep dynamic module loading, native assets, worker entries, declarations, and the shared Cordis instance intact; clean packed-install tests own that risk. The internal workspaces remain available to DSH development, but changing their graph does not require a corresponding Karaka package graph. SQLite persists chat ownership and events; pending structured questions remain process-local. TLS, replica count, cross-replica routing, and supervision remain deployment responsibilities.
