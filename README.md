# Karaka

English | [中文](README.zh.md)

Karaka is a self-hosted server for adding persistent AI agents to an application. Connect a backend or browser frontend to named agents, stream their responses, and let them call selected application functions as tools.

Each named agent is an Agent Preset: a Cordis plugin composition that defines its prompt, tools, skills, and model behavior. Karaka runs as a separate process and keeps durable chat state; your application owns user authentication and business authorization.

## What Karaka provides

- Durable chats bound to an application, tenant, and user.
- Independent Agent Presets with their own prompts, model behavior, skills, and allowed tools.
- A backend SDK for chat streams and authenticated MCP tool hosting.
- A browser client that uses expiring credentials issued by your backend.
- A profile-based Agent runtime launched through the Karaka CLI.

## How it fits

```text
Application backend                         Karaka process
@karaka-ai/sdk chat client  -- HTTP / SSE -->  named Agent Preset
@karaka-ai/sdk MCP tools     <--    MCP    --  selected application tools

Browser frontend                            Karaka process
@karaka-ai/agent/browser    -- HTTP / SSE -->  authenticated chat and events
```

Backend integrations use `@karaka-ai/sdk` for chat over HTTP/SSE and for hosting authenticated MCP tools on the application's existing HTTP server. The backend supplies trusted tenant and user identifiers. Karaka binds those identifiers to the chat and forwards them to tool callbacks, where the application enforces business authorization. Installing the SDK starts no process and opens no port.

Browser integrations use `@karaka-ai/agent/browser` with expiring credentials issued by the application backend. Each credential binds the application, tenant, and user identity; browser requests cannot choose another identity. See the [browser client setup](packages/karaka/transport-http) for authentication and server configuration.

<a id="run"></a>
## Start here

1. [Create an agent workspace](https://github.com/karaka-ai/karaka-cli) with the Karaka CLI.
2. [Configure the runtime](packages/karaka/agent) and each agent's plugins, then start the server.
3. Connect your [application backend](https://github.com/karaka-ai/karaka-sdk) or [browser frontend](packages/karaka/transport-http).
4. [Expose application tools](https://github.com/karaka-ai/karaka-sdk) and [select the tools each agent can use](packages/karaka/mcp-application).

Read the [runtime implementation guide](packages/karaka/agent/IMPLEMENTATION.md) for composition, builds, and deployment limitations. The CLI and SDK are maintained in their own repositories.

## Foundation

Karaka builds on the open-source [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) developed by [DeepSeek AI](https://deepseek.com) and retains its **everything-is-a-plugin** architecture powered by [Cordis](https://github.com/cordiverse/cordis). Karaka has its own `@karaka-ai/*` packages and `karaka` CLI.

## Developer preview

Karaka and its inherited Harness runtime are in _developer preview_ and may make compatibility-breaking changes. Review the [safety notice](SAFETY.md) before running the project.

<a id="run-from-source"></a>
## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
