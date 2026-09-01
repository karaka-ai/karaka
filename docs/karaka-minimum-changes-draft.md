# Karaka minimum runtime

English | [中文](karaka-minimum-changes-draft.zh.md)

## Requirements

The application backend uses one SDK to call named Karaka agents and to expose explicit business functions as authenticated MCP tools. Karaka runs as a separate persistent DSH process, loads Agent Presets from directories, preserves tenant and user ownership on every chat, and reuses the existing ReactLoopAgent, model, tool, Session, persistence, and Cordis lifecycle.

## Process split

- The application process owns `@karaka/sdk`, business functions, the existing Node HTTP server, and trusted tenant/user identity.
- The Karaka process owns `@karaka/cli`, `@karaka/harness`, Agent Presets, models, Sessions, and remote-tool discovery and invocation.
- The two processes authenticate each direction independently: application-to-Karaka chat and Karaka-to-application tools.

## Agent definitions

Each `agents/<id>` directory is an existing DSH Agent Preset. `preset.yml` carries discovery metadata. `agent.cordis.yml` carries behavior as ordinary Cordis plugin rows, including persona, selected MCP tools, skills, subagents, and user-authored plugins. Karaka mounts one standing tree for each detected composition generation. Chats joined to the same generation share its plugin instances while each receives its own Agent scope and durable Session; a changed composition starts a new generation without disrupting chats still joined to the old one. A new chat starts with the deployment's default model selection; `chats.setModel()` takes effect on that chat's next request and remains its selection without changing the deployment default or other chats.

## Package changes

| Change | Ownership |
|---|---|
| New `@karaka/sdk` library | Backend chat client, explicit MCP tool registry, Express and Next.js Pages handlers |
| New `@karaka/server-auth` plugin | Replaceable inbound and outbound application-server authentication |
| New `@karaka/transport-http` plugin | Authenticated JSON/SSE routes over the existing Host web server |
| New `@karaka/harness` bundle | Persistent safe composition over `dsh-base` |
| New `@karaka/cli` | Workspace scaffolding and launch through the existing `dsh` binary |
| Existing Session package | Atomic durable `{ applicationId, tenantId, userId }` owner |
| Existing JSONL and SQLite providers | Owner persistence in the current SQLite schema |
| Existing Session Controller | Workspace-free application chat lifecycle, ownership checks, deduplication, cold resume, idle eviction |
| Existing Agent and subagent packages | Owner admission and inheritance |
| Existing Agent Tool Presentation | Per-preset inherited MCP tool allow/deny selection |
| New `@karaka/mcp-application` plugin | Specialize the existing MCP client with outbound auth, owner metadata, and per-agent selection |
| New `@karaka/sdk` protocol and types | Shared runtime-validated application JSON/SSE contract |
| Existing App Boot | `karaka` profile template |

No second Agent loop, Session implementation, MCP client, tool registry, Loader, web server, or process manager is introduced.

## Request flow

1. The backend authenticates to Karaka and selects an Agent id for a trusted tenant and user.
2. HTTP transport derives the application id from the credential and admits the owner to Session Controller.
3. Session Controller creates or resumes a Session and scoped Agent from the selected preset.
4. ReactLoopAgent runs model steps and only the application tools explicitly allowed by that Agent Preset through the existing DSH registries.
5. Remote tool calls use the configured MCP endpoint, a fresh outbound credential, and trusted owner metadata.
6. SQLite persists the Session log and owner; SSE projects stable application events back to the SDK.

## Deliberate limits

The first runtime uses one Node process, HTTP JSON/SSE for chat, Streamable HTTP MCP for tools, shared-bearer server authentication, and SQLite persistence. Deployment supplies TLS, supervision, replica routing, and secrets. Distributed chat leases, cross-process structured-question recovery, entitlement, observability, Fetch-native tool handlers, and additional transports are outside this minimum.
