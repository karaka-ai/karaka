# Agent Note: Karaka application runtime reuses the scoped Harness

Status: implemented

English | [中文](2026-08-31-karaka-application-runtime.zh.md)

## Problem

An application backend needs to offer long-running, named agents without embedding the Harness, copying its Agent loop, or importing business code into the agent process. Several tenants and users may use the same agent definition concurrently. Business tools remain in the application process, while chat ownership must survive restart and every cross-process call must authenticate the server that made it.

## Decision

Karaka ships as an additional persistent DSH profile. [`@karaka/harness`](../../../../packages/karaka/harness/README.md) composes the existing Loader, workspace registry, [Agent Presets](2026-08-03-per-session-agent-presets.md), ReactLoopAgent, tool registry, model adapters, Session log, and SQLite provider. [`@karaka/cli`](../../../../packages/karaka/cli/README.md) scaffolds the deployment patch and Agent Preset directories, prepares the project-local profile home, makes the installed Harness bundle resolvable from that profile, then launches the existing `dsh` binary. It does not implement another runtime or process manager.

The application backend installs the separate [`@karaka/sdk`](../../../../packages/karaka/sdk/README.md). Its chat client calls the persistent process through authenticated JSON and SSE. Its tool host exposes explicitly registered application callbacks as stateless Streamable HTTP MCP tools on the backend's existing Node HTTP server; the SDK opens no port and starts no Karaka process.

One agent definition is one existing Agent Preset directory. `preset.yml` owns discovery metadata and `agent.cordis.yml` owns behavioral plugin composition. Each chat creates or resumes a distinct Agent and durable Session in that preset's scope. One standing tree is mounted for each detected composition generation, so chats joined to the same generation share its plugin instances. A changed composition starts a new generation while joined chats retain the old one. Plugins must keep mutable state on the Agent or Session, or key it by their identities, when that state must remain chat-local.

Every application chat Session has one atomic `{ applicationId, tenantId, userId }` owner in its durable header. The authenticated server supplies trusted tenant and user values; the inbound credential determines `applicationId`. Session Controller checks the same owner for every operation and retains active Agents only while needed. Application streaming reads the Session log directly, so cwd-less chats do not depend on the workspace-filtered browser history service. Subagents inherit the owner.

[`@karaka/server-auth`](../../../../packages/karaka/server-auth/README.md) is the replaceable Cordis authentication contract for both directions. Its bundled bearer provider resolves separate chat and tool credential references per operation. [`@karaka/mcp-application`](../../../../packages/karaka/mcp-application/README.md) specializes the existing [MCP client](../../../../packages/mcp/mcp-client/README.md) with that service, local argument validation, Agent Preset selection, and owner metadata from the executing Session. Arbitrary MCP and stdio endpoints keep their generic behavior. This extends rather than supersedes the [MCP client decision](../feature/2026-07-07-mcp-client-plugin.md).

## Alternatives considered

**Embed the Harness inside every application backend.** This couples application request workers to model-turn lifetime, duplicates the agent process across services, and prevents one persistent agent deployment from serving several backends.

**Create a Karaka-specific Agent Runtime and agent-definition schema.** This would duplicate ReactLoopAgent, scoped registries, Session durability, Agent Presets, and Cordis disposal. The existing preset directory already expresses both discovery metadata and plugin behavior.

**Import business functions into the Karaka process.** This makes the agent deployment carry application code and credentials. Authenticated MCP preserves the application as the execution owner and keeps tool discovery dynamic.

**Reuse the local DSH SDK JSON-RPC lifecycle.** That protocol owns a child Harness process and local byte streams. Karaka needs a caller-independent persistent server, stable application ownership, and reconnectable HTTP streaming.

## Consequences

Karaka adds a small application boundary while retaining upstream DSH behavior and plugin composition. Tool and chat transports require coordinated client and server implementations, but share runtime-validated wire types. SQLite persists chat ownership and events; pending structured questions remain process-local. One process serializes each chat, while TLS, replica count, cross-replica routing, and supervision remain deployment responsibilities. Local filesystem and subprocess tools are disabled by the Karaka bundle unless an explicit trusted composition enables them.
