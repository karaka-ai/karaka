---
description: "Backend SDK for authenticated Karaka chat calls and MCP tool hosting on an existing application HTTP server."
kind: "package-reference"
---

# @karaka/sdk

English | [中文](README.zh.md)

## Summary

`@karaka/sdk` is the application-backend package. `createKarakaClient()` calls an already-running Karaka server; `createKarakaToolHost()` exposes explicitly registered application functions as authenticated, stateless MCP tools through a caller-owned Node HTTP route. The SDK does not start Karaka or open a listener.

The package also owns the client-safe HTTP JSON/SSE schemas shared with Karaka's server transport. It has no Cordis, Agent, Session, or Harness runtime dependency.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Create one client with the Karaka endpoint and chat credential, then bind trusted `{ tenantId, userId }` data with `forUser()`. The optional `path` defaults to `/v1` and must match the HTTP transport plugin. The bound client lists agents and creates, sends, streams, reads, cancels, configures, and answers interactions for chats. Ending stream iteration cancels the response body; a server-side SSE error rejects iteration with its code.

Register tools with `registerTool(name, { description, inputSchema }, callback)`. Mount `expressHandler()` or `nextHandler()` on an application route and configure the same route as a Streamable HTTP MCP endpoint in Karaka. The callback receives validated object arguments and trusted `{ applicationId, tenantId, userId, chatId, signal }` context.

## Model Experience

Indirectly, through the Karaka application MCP plugin, which presents the registered tools selected by an Agent Preset.

#### KV Cache effect

Changing a selected tool name, description, or schema changes that agent's tool-schema request prefix; chat-client operations add no model context themselves.

## Known Limitations and Deferred Work

- **Node HTTP adapters only** — the tool host supports Express-compatible handlers and Next.js Pages API routes; Fetch-native route adapters are not included.
- **One HTTP transport** — chat uses JSON and SSE, while alternate application transports require matching SDK and server implementations.
- **Restricted input-schema vocabulary** — `inputSchema` must project to DSH's enforced object-rooted JSON Schema subset. Scalar types, object properties, required fields, arrays, enum/const, and `oneOf` are supported; constraints such as string lengths, numeric ranges, patterns, and formats are rejected with their schema paths when Karaka connects to the MCP endpoint.

### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>

None.

</details>
