---
description: "Discover and read MCP resources on demand with shared tools, explicit server selection, and agent-scoped access."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-resources

English | [中文](README.zh.md)

## Summary

`dsh-mcp-resources` lets the model discover and read documents from configured MCP servers. Choose it when an MCP server exposes resources or URI templates, including servers with no tools. Three shared tools require an explicit server name and read content only when called. Resource text enters conversation history; binary payloads remain available to programmatic callers and appear as descriptions to the model.

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

Mount this package once beside the [MCP client](../mcp-client/README.md) entries whose resources the model needs.

### Minimal configuration

The composition must already provide the tool registry. Add this service row; each MCP client entry supplies its own server configuration.

```yaml
- id: mcp-resources
  name: '@deepseek-ai/dsh-mcp-resources'
```

This package has no configuration fields. Mounting it adds the three shared tools; each MCP client supplies access to its configured server. Leaving this package unmounted keeps resource tools unavailable.

### Discover and read

When system-prompt assembly is mounted, the prompt lists server names visible to the calling agent. Call `list_mcp_resources` or `list_mcp_resource_templates` with one of those names as `server`. Without a cursor, the MCP SDK collects the server’s pages. An explicit `cursor` requests that page; pass a returned `nextCursor` unchanged. Read a listed URI or an expanded template with `read_mcp_resource`, using the same `server` name and an explicit `uri`.

Every operation resolves the server in the calling agent's scope. A missing server argument or unavailable server fails before dispatch. The connection owner handles request cancellation, timeouts, and recovery; a failed request remains a failed tool call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The scoped registry joins connection-owned providers to one shared set of tools and supplies their caller-visible server names to optional system-prompt assembly. Registrations follow Cordis effects, so disposing a provider removes that registration and exposes any inherited provider with the same name. Scope resolution happens during execution, before the provider receives the request.

Canonical results retain the complete JSON for programmatic callers. The pure text renderer adds server attribution and replaces string-valued `blob` fields with a description of their base64 length; URI, MIME type, and text fields remain in the rendered JSON. The tool pipeline owns recorded results. Server instructions belong to the MCP client and its logged system-prompt section.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Scoped provider selection and server-name prompt context |
| [`src/tools.ts`](src/tools.ts) | Shared resource operations and argument schemas |
| [`src/render.ts`](src/render.ts) | Attributed text projection without inline binary payloads |

No runtime invariant companion is published: the registry exposes no independent observation that can disagree with provider selection.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover server configuration, execution, and the decisions behind resource access.

- [MCP client](../mcp-client/README.md) — server transports, instructions, and connection lifecycle.
- [Tools subsystem](../../../docs/subsystems/tools.md) — canonical values and model-visible results.
- [Resources and instructions decision](../../../.agents/notes/implemented/feature/2026-09-12-mcp-resources-and-instructions.md) — scope, on-demand access, and excluded mechanisms.

-----

<a id="model-experience"></a>
## Model Experience

### Shared resource tools

#### What the model sees

The [generated tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-mcp-resources) define three tools shared by all configured servers. Their names and schemas do not change when a server connects or disconnects; execution still requires a caller-visible provider. When system-prompt assembly is mounted and providers are visible, the `MCP resource servers` section says `Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: <JSON array>.` The names come from the same scoped registry, including servers with neither tools nor instructions. An empty registry contributes no section.

#### Token effect

The three definitions contribute a fixed schema cost while mounted. When present, the server-name section adds a sorted JSON list of caller-visible names; resource listings and documents add no content until an operation returns them.

#### KV Cache effect

The definitions form a stable repeated prefix. Mounting, unmounting, or changing these tools can replace earlier request tokens. Changes to the caller-visible name set update the server-name section and its reusable prompt prefix; replacing a provider under the same name leaves that text unchanged.

### Resource results

#### What the model sees

A successful result starts with `MCP server: <server>`, followed by a newline and the returned JSON. Each string-valued `blob` becomes `[binary resource: <length> base64 characters; available to programmatic callers]`. Server-provided text, metadata, and continuation cursors remain visible.

#### Token effect

Rendered results add text to tool history. Binary descriptions replace the payload's base64 token cost; this package imposes no separate text-size limit.

#### KV Cache effect

Each result appends to history without rewriting earlier results. Later reads can return changed server content and append a different result; the package does not refresh previously recorded content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Resource access is explicit and on demand.

- Resource subscriptions and update notifications are unsupported; call the list or read tools again to obtain current content.
- Binary resources are not projected as native images or audio. Programmatic callers retain their canonical base64 values.
- The caller must supply a server name. The shared tools do not aggregate different servers; pagination follows the MCP SDK.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
