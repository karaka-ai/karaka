---
description: "The Karaka package group: application identity, authentication, browser and HTTP access, and application MCP tools for embedded agents."
kind: "package-group"
---

# karaka/ — application agents

English | [中文](README.zh.md)

## Summary

Karaka lets applications create owned conversations, authenticate browser and server clients, and expose selected application tools to an agent. The agent bundle composes these packages with DSH's model, tool, loop, and persistence implementations. Choose the package below for its configuration and access rules.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package owns one part of application access or deployment.

| Package | Role |
|---|---|
| [`agent`](agent/README.md) | Compose and launch the Karaka application profile |
| [`identity`](identity/README.md) | Keep durable conversation ownership separate from DSH Session logs |
| [`server-auth`](server-auth/README.md) | Authenticate server requests and resolve application credentials |
| [`browser-auth`](browser-auth/README.md) | Verify browser credentials against configured issuers and applications |
| [`transport-http`](transport-http/README.md) | Serve owner-filtered conversation operations to server and browser clients |
| [`mcp-application`](mcp-application/README.md) | Expose application MCP tools under endpoint and preset permissions |

<a id="related-documentation"></a>
## Related documentation

- [Karaka subsystem](../../docs/subsystems/karaka.md) — application authority and integration APIs.
- [Runtime packaging](agent/IMPLEMENTATION.md) — assembled artifacts and integration-test scope.
- [Harness architecture](../../docs/architecture.md) — the shared runtime and its extension points.

<a id="dev-note"></a>
## Dev Note

None.
