---
description: "Package map for the Karaka application boundary, persistent server profile, and launcher."
kind: "package-group"
---

# karaka/ — application-facing Karaka packages

English | [中文](README.zh.md)

## Summary

The `karaka/` group connects an application backend to a persistent, multi-agent Harness process. The SDK owns backend chat calls and MCP tool hosting; Cordis plugins own server authentication and HTTP ingress; the harness bundle and CLI own the safe persistent-server composition and launch path.

## Packages

| Package | Role |
|---|---|
| [`sdk/`](sdk/README.md) | Backend chat client and authenticated MCP tool host |
| [`server-auth/`](server-auth/README.md) | Replaceable application-server authentication |
| [`mcp-application/`](mcp-application/README.md) | Authenticated application MCP tool bridge |
| [`transport-http/`](transport-http/README.md) | Authenticated JSON and SSE application ingress |
| [`harness/`](harness/README.md) | Persistent Karaka Cordis bundle |
| [`cli/`](cli/README.md) | Agent-workspace scaffolding and launcher |

See the [Karaka application subsystem](../../docs/subsystems/karaka-application.md) for the boundary contract and the [architecture](../../docs/architecture.md#karaka-application-runtime) for the process flow.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
