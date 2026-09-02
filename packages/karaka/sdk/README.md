---
description: "Backend library for authenticated Karaka chat calls and MCP tool hosting on an existing application HTTP server."
kind: "package-library"
---

# @karaka-ai/sdk

English | [中文](README.zh.md)

## Summary

`@karaka-ai/sdk` lets an application backend chat with agents in a running Karaka server and expose application functions as authenticated MCP tools. `createKarakaClient()` owns outbound JSON/SSE calls; `createKarakaToolHost()` owns an explicit tool registry and handlers for an existing Node HTTP route. The SDK starts no process, opens no listener, and has no Cordis, Agent, Session, or Harness runtime dependency.

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

Declare `@karaka-ai/sdk` and `zod` as application dependencies, then import the SDK in the backend that already authenticates users and owns business operations. Run the Karaka server separately through `@karaka-ai/cli`; do not mount the SDK in `cordis.yml`.

### Chat with an agent

Create one deployment client, then bind the trusted tenant and user identity for each backend request:

```ts
import { createKarakaClient } from '@karaka-ai/sdk'

const karaka = createKarakaClient({
  endpoint: process.env.KARAKA_ENDPOINT!,
  chatToken: () => process.env.KARAKA_CHAT_TOKEN!,
})

const user = karaka.forUser({ tenantId: 'tenant-1', userId: 'user-1' })
const chat = await user.chats.create({ agentId: 'support' })

await user.chats.send({ chatId: chat.chatId, content: 'Help me with an invoice' })

for await (const event of user.chats.stream({ chatId: chat.chatId })) {
  if (event.type === 'text-delta') process.stdout.write(event.text)
  if (event.type === 'turn-end') break
}
```

`agents.list()` discovers available agents before chat creation. The bound client can also read history, cancel a turn, select a model, and answer a structured interaction. The optional client `path` defaults to `/v1` and must match the Karaka HTTP transport.

### Expose an application tool

Register each callable function explicitly and export a handler for the application server to mount on its own route:

```ts
import { createKarakaToolHost } from '@karaka-ai/sdk'
import { z } from 'zod'

const echoInput = z.object({ text: z.string() }).strict()
const toolHost = createKarakaToolHost({
  verifyToken: () => process.env.KARAKA_TOOL_TOKEN!,
})

toolHost.registerTool('support_echo', {
  description: 'Echo text for support diagnostics',
  inputSchema: echoInput,
}, (input, context) => {
  const { text } = echoInput.parse(input)
  return { content: [{ type: 'text', text: `${context.userId}: ${text}` }] }
})

export const karakaMcpHandler = toolHost.expressHandler()
```

Mount `karakaMcpHandler` on the application route configured in Karaka as a Streamable HTTP MCP endpoint. Karaka authenticates before discovery and invocation, and the callback receives trusted `{ applicationId, tenantId, userId, chatId, signal }` context. The callback must still enforce the application's business authorization. Call `toolHost.close()` during application shutdown.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The client validates every JSON response and SSE event before returning it. `forUser()` creates an identity-bound view without storing a process-global current user. The tool host authenticates every MCP request, creates an isolated stateless MCP server for that request, validates object-rooted Zod input, and supplies invocation identity outside model-generated arguments.

| File | Responsibility |
|---|---|
| [`src/client.ts`](src/client.ts) | Authenticated chat client and SSE parsing |
| [`src/tools.ts`](src/tools.ts) | Tool registry, server authentication, and Node HTTP handlers |
| [`src/protocol.ts`](src/protocol.ts) | Runtime-validated JSON/SSE protocol shared with the server transport |
| [`src/types.ts`](src/types.ts) | Public tool and identity types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Karaka overview](../../../README.md) — understand the application and server processes.
- [Karaka package map](../README.md) — find the server-side packages paired with the SDK.
- [Application runtime architecture](../../../docs/architecture.md#karaka-application-runtime) — follow identity, chat, and tool traffic across processes.
- [Server authentication](../server-auth/README.md) — configure the credentials used in each direction.
- [Application MCP bridge](../mcp-application/README.md) — select SDK-hosted tools for an Agent Preset.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Karaka application MCP plugin, which presents the registered tools selected by an Agent Preset.

#### KV Cache effect

Changing a selected tool name, description, or schema changes that agent's tool-schema request prefix; chat-client operations add no model context themselves.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Node HTTP adapters only** — the tool host supports Express-compatible handlers and Next.js Pages API routes; Fetch-native route adapters are not included.
- **One HTTP transport** — chat uses JSON and SSE, while alternate application transports require matching SDK and server implementations.
- **Restricted input-schema vocabulary** — `inputSchema` must project to DSH's enforced object-rooted JSON Schema subset. Scalar types, object properties, required fields, arrays, enum/const, and `oneOf` are supported; constraints such as string lengths, numeric ranges, patterns, and formats are rejected with their schema paths when Karaka connects to the MCP endpoint.

<a id="dev-note"></a>
### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>

None.

</details>
