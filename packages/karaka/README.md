---
description: "Package map for the Karaka backend SDK, self-contained Agent runtime, and launcher."
kind: "package-group"
---

# karaka/ — application-facing Karaka packages

English | [中文](README.zh.md)

## Summary

The `karaka/` group connects an application backend to a persistent Karaka Agent process. The SDK owns backend chat calls and MCP tool hosting, the Agent package owns the complete server runtime, and the CLI creates and starts Agent projects.

## Packages

| Package | Role |
|---|---|
| [`sdk/`](sdk/README.md) | Backend chat client and authenticated MCP tool host |
| [`agent/`](agent/README.md) | Self-contained Cordis Agent runtime and application server |
| [`cli/`](cli/README.md) | Agent-project scaffolding and launcher |

Server authentication, HTTP transport, and the application MCP bridge are internal Agent modules rather than independent releases. See the [Karaka application subsystem](../../docs/subsystems/karaka-application.md) for the integration contract and the [architecture](../../docs/architecture.md#karaka-application-runtime) for the process flow.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
