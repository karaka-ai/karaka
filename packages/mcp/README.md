---
description: "The MCP package group: connect external Model Context Protocol servers, call their tools, and read their resources."
kind: "package-group"
---

# MCP — Model Context Protocol

English | [中文](README.zh.md)

## Summary

The `mcp/` group lets the model call external Model Context Protocol (MCP) tools and read server resources. Configure each server through `mcp-client`; mount `mcp-resources` to add shared resource discovery and reading. Connections also supply server instructions to the model. These capabilities are opt-in, and package READMEs own their configuration and limitations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose the connection package for each server and the resource package when the model needs resource access.

| Package | What it provides |
|---|---|
| [`mcp-client/`](mcp-client/README.md) | Connect one MCP server, expose its tools and instructions, and provide its resource operations |
| [`mcp-resources/`](mcp-resources/README.md) | Discover and read resources through shared tools with explicit server selection |

-----

<a id="related-documentation"></a>
## Related documentation

Try the worked example configurations to see the plugin in action, then read the Agent Note for the behavior decisions behind it.

- [MCP client plugin Agent Note](../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md) — the bridge's design: server-qualified naming, discovery, execution, and environment scrubbing.
- [Resources and instructions Agent Note](../../.agents/notes/implemented/feature/2026-09-12-mcp-resources-and-instructions.md) — on-demand resource access and scoped server guidance.
- [Third-party memory MCP guide](../../docs/user/guide/mcp-memory.md) — runnable overlay rows and setup instructions.
- [Tools subsystem reference](../../docs/subsystems/tools.md) — the `ToolRuntime` that receives the registered tools.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
