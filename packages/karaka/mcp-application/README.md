---
description: "Authenticated discovery and invocation of application-owned MCP tools from Karaka Agent Presets."
kind: "package-reference"
---

# @karaka/mcp-application

English | [中文](README.zh.md)

## Summary

`@karaka/mcp-application` connects Karaka to one application's Streamable HTTP MCP endpoint. It resolves outbound authorization through `ctx.serverAuth`, exposes only tools explicitly selected by an Agent Preset, and forwards the executing Session's application, tenant, user, and chat identifiers with each call.

## Table of Contents

- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="configuration"></a>
## Configuration

Mount one row in the deployment composition for each application tool endpoint. The `applicationId` must match a configured `ctx.serverAuth` application; the remaining fields are the generic Streamable HTTP MCP settings.

```yaml
- id: billing-tools
  name: '@karaka/mcp-application'
  config:
    serverName: billing
    url: https://billing.internal/mcp
    applicationId: billing
```

The Agent Preset selects individual qualified names through its existing tool `allow` list. A tool remains hidden from other applications and from presets that do not select it.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the discovered MCP tool schemas explicitly selected by the active Agent Preset.

#### KV Cache effect

Selected schemas extend the model request prefix; a changed remote tool generation can invalidate that prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Streamable HTTP only** — application tool endpoints cannot use the generic MCP client's stdio transport.
- **Application-owned Sessions only** — calls without matching Session owner metadata fail before MCP invocation.

<a id="dev-note"></a>
### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>

None.

</details>
