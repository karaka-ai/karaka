---
description: "Configure authenticated application MCP catalogs, inherited tool restrictions, schema admission and reconnect behavior."
kind: "package-reference"
---
# @karaka-ai/mcp-application

English | [中文](README.zh.md)

## Summary

Applications can expose selected MCP tools only to Agents with matching trusted ownership. The bridge renews credentials for every HTTP request and checks ownership and current policy before dispatch. Explicit endpoint and preset allow lists determine which tools appear. DSH Tools retains execution, argument-error classification and model-result handling.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in the application composition with Tools, Agents, [identity](../identity/README.md) and [server authentication](../server-auth/README.md). Configure `applicationId`, a stable `serverName`, and an HTTP(S) `url`. Public names use `mcp__<serverName>__<rawName>`, with deterministic normalization when required by model naming limits.

The endpoint `allow` and `deny` lists use public tool names and default to empty. An Agent preset must also mount `./tool-policy` with an explicit allow list. Every enclosing allow list must admit the tool; any deny list rejects it. `mode` selects native, PTC or both presentations. Tool-policy registrations unwind when their preset unloads.

`headers` supplies static headers, while `serverAuth` supplies current authorization before each HTTP request. Redirects are rejected. `toolCallTimeoutMs` defaults to 60,000. `failOnStartupError` defaults to true. Optional `reconnect` controls transport-close recovery: enabled by default, with a 500 ms initial delay, a 30,000 ms maximum delay and ten failed attempts per outage.

Input schemas must use the supported object-rooted DSH JSON Schema subset. The root `$schema` marker is omitted, and unsupported input keywords reject catalog admission. Local argument validation rejects with `INVALID_ARGS` before any MCP callback; remote failures do not prove the operation had no effect.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Scoped catalogs and connection ownership</summary>

Each endpoint owns a private catalog. Authorized Agent scopes receive admitted definitions, and invocation metadata comes from trusted Session ownership. Policy changes refresh scoped registrations. Discovery builds the complete next catalog before replacing the previous generation; connection disposal waits for in-flight discovery and removes its contributions.

The package uses the shared [DSH MCP client extensions](../../mcp/mcp-client/README.md#programmatic-extensions) for connection supervision, discovery and rich result conversion. Karaka uses the same MCP SDK client as DSH and supplies authenticated HTTP transports, verified invocation metadata, strict schema admission and scoped catalog registration. The public factory passes the exact tool execution to the metadata hook before dispatch; its result conversion and finalization remain upstream-owned. The [upstream source record](UPSTREAM.json) identifies the shared implementation and application-owned adapters.

No runtime invariant companion is published: asynchronous catalog refresh has no independent server-to-tool snapshot. The executor rechecks ownership and policy before each dispatch.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Admitted application tools

#### What the model sees

Only tools admitted by endpoint policy, trusted ownership and inherited preset policy appear, with their server-provided descriptions and supported input schemas. Credentials and invocation ownership metadata do not enter the tool schema.

#### Token effect

Visible tool names, descriptions and schemas contribute request tokens while registered. Catalog refresh replaces definitions rather than accumulating copies.

#### KV Cache effect

An unchanged admitted catalog preserves the tool-definition prefix. Catalog or policy changes that alter the visible definitions may invalidate reuse from the first changed token.

### Tool results and argument failures

#### What the model sees

DSH Tools reports local `INVALID_ARGS` errors without MCP dispatch. Successful results retain text and eligible durable images; refused images and unsupported rich blocks produce text diagnostics. MCP application errors retain their failure classification.

#### Token effect

Visible result text and image references remain in history until compaction. A corrected argument proposal incurs its normal model-call cost. Raw inline media remains available only in the execution result for programmatic callers.

#### KV Cache effect

Tool results append after the existing request prefix; local validation adds no independent prompt or prefix replacement.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The bridge retains these MCP and application limits.

- Application MCP tools are supported; application resources, server instructions, prompts and task-based execution are not published by this bridge. Unsupported input schemas reject admission, while unsupported output schemas fall back to JSON values.
- Startup and discovery use MCP SDK timeouts. HTTP request failures use the SDK transport recovery; the supervisor reconnects on transport close.
- Application domain constraints, side-effect accounting and transaction guarantees remain the callback owner's responsibility. Only local argument rejection establishes that no callback was dispatched.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
